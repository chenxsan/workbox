/*
  Copyright 2018 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

import {cacheNames} from 'workbox-core/_private/cacheNames.mjs';
import {logger} from 'workbox-core/_private/logger.mjs';
import {PrecacheController} from 'workbox-precaching/PrecacheController.mjs';
import {resetDefaultPrecacheController} from './resetDefaultPrecacheController.mjs';
import {spyOnEvent} from '../../../infra/testing/helpers/extendable-event-utils.mjs';
import generateTestVariants from '../../../infra/testing/generate-variant-tests';


describe(`PrecacheController`, function() {
  const sandbox = sinon.createSandbox();

  beforeEach(async function() {
    sandbox.restore();
    resetDefaultPrecacheController();

    if (logger) {
      sandbox.spy(logger, 'log');
    }

    sandbox.stub(self, 'fetch').callsFake(() => {
      return Promise.resolve(new Response('stub'));
    });

    // Spy on all added event listeners so they can be removed.
    sandbox.spy(self, 'addEventListener');

    // Clear all caches.
    const cacheKeys = await caches.keys();
    for (const cacheKey of cacheKeys) {
      await caches.delete(cacheKey);
    }
  });

  afterEach(function() {
    for (const args of self.addEventListener.args) {
      self.removeEventListener(...args);
    }
    sandbox.restore();
  });

  describe(`constructor`, function() {
    it(`should construct without any inputs`, async function() {
      expect(() => {
        new PrecacheController();
      }).to.not.throw();
    });

    it(`should construct with a valid cache name`, async function() {
      expect(() => {
        new PrecacheController(`test-cache-name`);
      }).to.not.throw();
    });

    // TODO Add tests on bad cachename input
  });

  describe(`addToCacheList()`, function() {
    const badTopLevelInputs = [
      {},
      true,
      false,
      123,
      '',
      null,
      undefined,
    ];
    generateTestVariants(`should throw when passing in non-array values in dev`, badTopLevelInputs, async function(variant) {
      if (process.env.NODE_ENV === 'production') return this.skip();

      const precacheController = new PrecacheController();
      return expectError(() => {
        precacheController.addToCacheList(variant);
      }, 'not-an-array');
    });

    const badNestedInputs = [
      true,
      false,
      123,
      null,
      undefined,
      [],
      '',
      {},
    ];

    generateTestVariants(`should throw when passing in invalid inputs in the array in dev`, badNestedInputs, async function(variant) {
      if (process.env.NODE_ENV == 'production') return this.skip();

      const precacheController = new PrecacheController();
      return expectError(() => {
        precacheController.addToCacheList([variant]);
      }, 'add-to-cache-list-unexpected-type', (err) => {
        expect(err.details.entry).to.deep.equal(variant);
      });
    });

    const unrevisionedEntryGroups = {
      'string entries': [
        '/',
        '/hello.html',
        '/styles/hello.css',
        '/scripts/controllers/hello.js',
      ],
      'url only object entries': [
        {url: '/'},
        {url: '/hello.html'},
        {url: '/styles/hello.css'},
        {url: '/scripts/controllers/hello.js'},
      ],
    };

    Object.keys(unrevisionedEntryGroups).forEach((groupName) => {
      const inputGroup = unrevisionedEntryGroups[groupName];

      it(`should add ${groupName} to cache list in dev`, async function() {
        if (process.env.NODE_ENV === 'production') this.skip();

        const precacheController = new PrecacheController();

        precacheController.addToCacheList(inputGroup);

        expect(precacheController._urlsToCacheKeys.size).to.equal(inputGroup.length);

        inputGroup.forEach((inputValue) => {
          const urlValue = new URL(inputValue.url || inputValue, location).href;

          const cacheKey = precacheController._urlsToCacheKeys.get(urlValue);
          expect(cacheKey).to.eql(urlValue);
        });
      });

      it(`should remove duplicate ${groupName}`, async function() {
        const precacheController = new PrecacheController();

        const inputURLs = [
          ...inputGroup,
          ...inputGroup,
        ];

        precacheController.addToCacheList(inputURLs);

        expect([...precacheController._urlsToCacheKeys.values()]).to.eql([
          `${location.origin}/`,
          `${location.origin}/hello.html`,
          `${location.origin}/styles/hello.css`,
          `${location.origin}/scripts/controllers/hello.js`,
        ]);
      });
    });

    it(`should log a warning unless an entry has a revision property`, function() {
      const logObject = process.env.NODE_ENV === 'production' ? console : logger;
      const warnStub = sandbox.stub(logObject, 'warn');

      const precacheController = new PrecacheController();

      precacheController.addToCacheList([
        '/should-warn',
      ]);
      expect(warnStub.calledOnce).to.be.true;
      warnStub.resetHistory();

      precacheController.addToCacheList([
        {url: '/also-should-warn'},
      ]);
      expect(warnStub.calledOnce).to.be.true;
      warnStub.resetHistory();

      precacheController.addToCacheList([
        {url: '/should-not-warn', revision: null},
        {url: '/also-should-not-warn', revision: '1234abcd'},
      ]);
      expect(warnStub.notCalled).to.be.true;
    });

    it(`should add url + revision objects to cache list`, async function() {
      const precacheController = new PrecacheController();

      const inputObjects = [
        {url: '/', revision: '123'},
        {url: '/hello.html', revision: '123'},
        {url: '/styles/hello.css', revision: '123'},
        {url: '/scripts/controllers/hello.js', revision: '123'},
      ];
      precacheController.addToCacheList(inputObjects);

      expect([...precacheController._urlsToCacheKeys.values()]).to.eql([
        `${location.origin}/?__WB_REVISION__=123`,
        `${location.origin}/hello.html?__WB_REVISION__=123`,
        `${location.origin}/styles/hello.css?__WB_REVISION__=123`,
        `${location.origin}/scripts/controllers/hello.js?__WB_REVISION__=123`,
      ]);
    });

    it(`should remove duplicate url + revision object entries`, async function() {
      const precacheController = new PrecacheController();

      const singleObject = {
        url: new URL('/duplicate.html', location).href,
        revision: '123',
      };
      const inputObjects = [
        singleObject,
        singleObject,
      ];
      precacheController.addToCacheList(inputObjects);

      expect(precacheController._urlsToCacheKeys.size).to.equal(1);
      expect(precacheController._urlsToCacheKeys.has(singleObject.url)).to.be.true;
    });

    it(`should throw on conflicting entries with different revisions`, async function() {
      const firstEntry = {url: '/duplicate.html', revision: '123'};
      const secondEntry = {url: '/duplicate.html', revision: '456'};
      return expectError(() => {
        const precacheController = new PrecacheController();
        const inputObjects = [
          firstEntry,
          secondEntry,
        ];
        precacheController.addToCacheList(inputObjects);
      }, 'add-to-cache-list-conflicting-entries', (err) => {
        expect(err.details.firstEntry).to.eql(`${location.origin}/duplicate.html?__WB_REVISION__=123`);
        expect(err.details.secondEntry).to.eql(`${location.origin}/duplicate.html?__WB_REVISION__=456`);
      });
    });
  });

  describe('install()', function() {
    it('should be fine when calling with empty precache list', async function() {
      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      const precacheController = new PrecacheController();
      return precacheController.install({event});
    });

    it('should precache assets (with cache busting via search params)', async function() {
      const precacheController = new PrecacheController();
      const cacheList = [
        '/index.1234.html',
        {url: '/example.1234.css'},
        {url: '/scripts/index.js', revision: '1234'},
        {url: '/scripts/stress.js?test=search&foo=bar', revision: '1234'},
      ];
      precacheController.addToCacheList(cacheList);

      if (process.env.NODE_ENV !== 'production') {
        // Reset as addToCacheList will log.
        logger.log.resetHistory();
      }

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      const updateInfo = await precacheController.install({event});
      expect(updateInfo.updatedURLs.length).to.equal(cacheList.length);
      expect(updateInfo.notUpdatedURLs.length).to.equal(0);

      const cache = await caches.open(cacheNames.getPrecacheName());
      const keys = await cache.keys();
      expect(keys.length).to.equal(cacheList.length);

      const expectedCacheKeys = [
        `${location.origin}/index.1234.html`,
        `${location.origin}/example.1234.css`,
        `${location.origin}/scripts/index.js?__WB_REVISION__=1234`,
        `${location.origin}/scripts/stress.js?test=search&foo=bar&__WB_REVISION__=1234`,
      ];
      for (const key of expectedCacheKeys) {
        const cachedResponse = await cache.match(key);
        expect(cachedResponse, `${key} is missing from the cache`).to.exist;
      }

      if (process.env.NODE_ENV !== 'production') {
        // Make sure we print some debug info.
        expect(logger.log.callCount).to.be.gt(0);
      }
    });

    it(`should copy the response for redirected entries`, async function() {
      self.fetch.restore();
      sandbox.stub(self, 'fetch').callsFake((request) => {
        const response = new Response('Redirected Response');
        sandbox.replaceGetter(response, 'redirected', () => true);
        sandbox.replaceGetter(response, 'url',
            () => (new URL(request.url, self.location.href)).href);
        return response;
      });

      const precacheController = new PrecacheController();
      precacheController.addToCacheList([
        '/index.1234.html',
        {url: '/example.1234.css'},
        {url: '/scripts/index.js', revision: '1234'},
      ]);

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      await precacheController.install({event});
    });

    it(`should use the desired cache name`, async function() {
      const precacheController = new PrecacheController(`test-cache-name`);

      const cacheList = [
        {url: '/scripts/index.js', revision: '1234'},
        {url: '/index.html', revision: '1234'},
      ];

      precacheController.addToCacheList(cacheList);

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      await precacheController.install({event});

      const cache = await caches.open(`test-cache-name`);
      const keys = await cache.keys();
      expect(keys.length).to.equal(cacheList.length);

      const expectedCacheKeys = [
        `${location.origin}/index.html?__WB_REVISION__=1234`,
        `${location.origin}/scripts/index.js?__WB_REVISION__=1234`,
      ];
      for (const key of expectedCacheKeys) {
        const cachedResponse = await cache.match(key);
        expect(cachedResponse).to.exist;
      }
    });

    it('should update assets that have changed', async function() {
      const initialPrecacheController = new PrecacheController();

      const initialCacheList = [
        '/index.1234.html',
        {url: '/example.1234.css'},
        {url: '/scripts/index.js', revision: '1234'},
        {url: '/scripts/stress.js?test=search&foo=bar', revision: '1234'},
      ];

      initialPrecacheController.addToCacheList(initialCacheList);

      // Reset as addToCacheList will log.
      if (process.env.NODE_ENV !== 'production') {
        logger.log.resetHistory();
      }

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      const initialInstallInfo = await initialPrecacheController.install({event});

      const initialExpectedCacheKeys = [
        `${location.origin}/index.1234.html`,
        `${location.origin}/example.1234.css`,
        `${location.origin}/scripts/index.js?__WB_REVISION__=1234`,
        `${location.origin}/scripts/stress.js?test=search&foo=bar&__WB_REVISION__=1234`,
      ];

      expect(initialInstallInfo.updatedURLs).to.have.members([
        `${location.origin}/index.1234.html`,
        `${location.origin}/example.1234.css`,
        `${location.origin}/scripts/index.js`,
        `${location.origin}/scripts/stress.js?test=search&foo=bar`,
      ]);
      expect(initialInstallInfo.notUpdatedURLs).to.be.empty;

      if (process.env.NODE_ENV != 'production') {
        // Make sure we print some debug info.
        expect(logger.log.callCount).to.be.gt(0);
      }

      let cache = await caches.open(cacheNames.getPrecacheName());
      const initialCacheKeys = await cache.keys();
      // Get the url field out of each Request object.
      expect(initialCacheKeys.map((r) => r.url)).to.have.members(initialExpectedCacheKeys);

      const initialActivateInfo = await initialPrecacheController.activate();
      expect(initialActivateInfo.deletedURLs).to.be.empty;

      // Make sure the files are cached after activation.
      for (const key of initialExpectedCacheKeys) {
        const cachedResponse = await cache.match(key);
        expect(cachedResponse, `${key} is not cached`).to.exist;
      }

      const updatePrecacheController = new PrecacheController();

      const updateCacheList = [
        '/index.4321.html',
        {url: '/example.1234.css'},
        {url: '/scripts/index.js', revision: '1234'},
        {url: '/scripts/stress.js?test=search&foo=bar', revision: '4321'},
      ];

      updatePrecacheController.addToCacheList(updateCacheList);

      if (process.env.NODE_ENV !== 'production') {
        // Reset as addToCacheList will log.
        logger.log.resetHistory();
      }

      const updateInstallInfo = await updatePrecacheController.install({event});
      expect(updateInstallInfo.updatedURLs).to.have.members([
        `${location.origin}/index.4321.html`,
        `${location.origin}/scripts/stress.js?test=search&foo=bar`,
      ]);
      expect(updateInstallInfo.notUpdatedURLs).to.have.members([
        `${location.origin}/example.1234.css`,
        `${location.origin}/scripts/index.js`,
      ]);

      // The cache mock needs the cache to be re-opened to have up-to-date keys.
      cache = await caches.open(cacheNames.getPrecacheName());
      const updateCacheKeys = await cache.keys();
      // Get the url field out of each Request object.
      expect(updateCacheKeys.map((r) => r.url)).to.have.members([
        `${location.origin}/index.1234.html`,
        `${location.origin}/index.4321.html`,
        `${location.origin}/example.1234.css`,
        `${location.origin}/scripts/index.js?__WB_REVISION__=1234`,
        `${location.origin}/scripts/stress.js?test=search&foo=bar&__WB_REVISION__=1234`,
        `${location.origin}/scripts/stress.js?test=search&foo=bar&__WB_REVISION__=4321`,
      ]);

      if (process.env.NODE_ENV != 'production') {
        // Make sure we print some debug info.
        expect(logger.log.callCount).to.be.gt(0);
      }

      const updateActivateInfo = await updatePrecacheController.activate();
      expect(updateActivateInfo.deletedURLs).to.have.members([
        `${location.origin}/index.1234.html`,
        `${location.origin}/scripts/stress.js?test=search&foo=bar&__WB_REVISION__=1234`,
      ]);

      const expectedPostActivateUpdateCacheKeys = [
        `${location.origin}/index.4321.html`,
        `${location.origin}/example.1234.css`,
        `${location.origin}/scripts/index.js?__WB_REVISION__=1234`,
        `${location.origin}/scripts/stress.js?test=search&foo=bar&__WB_REVISION__=4321`,
      ];

      // The cache mock needs the cache to be re-opened to have up-to-date keys.
      cache = await caches.open(cacheNames.getPrecacheName());
      const postActivateUpdateCacheKeys = await cache.keys();
      // Get the url field out of each Request object.
      expect(postActivateUpdateCacheKeys.map((r) => r.url)).to.have.members(expectedPostActivateUpdateCacheKeys);

      // Make sure the files are cached after activation.
      for (const key of expectedPostActivateUpdateCacheKeys) {
        const cachedResponse = await cache.match(key);
        expect(cachedResponse, `${key} is not cached`).to.exist;
      }
    });

    it('should precache with plugins', async function() {
      const precacheController = new PrecacheController();
      const cacheList = [
        '/index.1234.html',
        {url: '/example.1234.css'},
        {url: '/scripts/index.js', revision: '1234'},
        {url: '/scripts/stress.js?test=search&foo=bar', revision: '1234'},
      ];
      precacheController.addToCacheList(cacheList);

      const testPlugins = [
        {
          requestWillFetch: sandbox.stub().callsFake(({request}) => request),
          cacheWillUpdate: sandbox.stub().callsFake(({response}) => response),
        },
        {
          requestWillFetch: sandbox.stub().callsFake(({request}) => request),
          cacheWillUpdate: sandbox.stub().callsFake(({response}) => response),
        },
      ];

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      await precacheController.install({
        event,
        plugins: testPlugins,
      });

      expect(testPlugins[0].requestWillFetch.callCount).to.equal(4);
      expect(testPlugins[0].cacheWillUpdate.callCount).to.equal(4);
      expect(testPlugins[1].requestWillFetch.callCount).to.equal(4);
      expect(testPlugins[1].cacheWillUpdate.callCount).to.equal(4);

      // TODO(philipwalton): this was included in the original test, but it
      // probably makes sense to test this separately given the changes.
      expect(precacheController._strategy.matchOptions.ignoreSearch).to.equal(true);
    });

    it(`should use the proper 'this' when calling a cacheWillUpdate plugin`, async function() {
      const precacheController = new PrecacheController();
      const cacheList = [
        '/index.1234.html',
      ];
      precacheController.addToCacheList(cacheList);

      class TestPlugin {
        cacheWillUpdate({response}) {
          return response;
        }
      }
      const pluginInstance = new TestPlugin();
      const cacheWillUpdateSpy = sandbox.spy(pluginInstance, 'cacheWillUpdate');

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      await precacheController.install({
        event,
        plugins: [pluginInstance],
      });

      expect(cacheWillUpdateSpy.thisValues[0]).to.be.an.instanceof(TestPlugin);
    });

    it(`should set credentials: 'same-origin' on the precaching requests`, async function() {
      const precacheController = new PrecacheController();
      const cacheList = [
        '/index.1234.html',
      ];
      precacheController.addToCacheList(cacheList);

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      await precacheController.install({event});

      expect(self.fetch.calledOnce).to.be.true;

      const request = self.fetch.args[0][0];
      expect(request.credentials).to.eql('same-origin');
    });

    it(`should use cache: 'reload' on the precaching requests when there's a revision field`, async function() {
      const precacheController = new PrecacheController();
      const cacheList = [
        {url: '/test', revision: 'abcd'},
      ];
      precacheController.addToCacheList(cacheList);

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      await precacheController.install({event});

      expect(self.fetch.calledOnce).to.be.true;

      const request = self.fetch.args[0][0];
      expect(request.url).to.eql(`${location.origin}/test`);
      expect(request.cache).to.eql('reload');
    });

    it(`should use cache: 'default' on the precaching requests when there's no revision field`, async function() {
      const precacheController = new PrecacheController();
      const cacheList = [
        {url: '/test'},
      ];
      precacheController.addToCacheList(cacheList);

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      await precacheController.install({event});

      expect(self.fetch.calledOnce).to.be.true;

      const request = self.fetch.args[0][0];
      expect(request.url).to.eql(`${location.origin}/test`);
      expect(request.cache).to.eql('default');
    });

    it(`should pass in a request that includes the revision to cacheWrapper.put()`, async function() {
      const putStub = sandbox.stub(Cache.prototype, 'put');

      const precacheController = new PrecacheController();
      const cacheList = [
        {url: '/test', revision: 'abcd'},
      ];
      precacheController.addToCacheList(cacheList);

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      await precacheController.install({event});

      expect(putStub.calledOnce).to.be.true;

      const request = putStub.args[0][0];
      expect(request.url).to.eql(`${location.origin}/test?__WB_REVISION__=abcd`);
    });

    it(`should use the integrity value when making requests`, async function() {
      const precacheController = new PrecacheController();
      const cacheList = [
        {url: '/first'},
        {url: '/second', integrity: 'sha256-second'},
      ];
      precacheController.addToCacheList(cacheList);

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      await precacheController.install({event});

      expect(self.fetch.calledTwice).to.be.true;
      expect(self.fetch.args[0][0].integrity).to.eql('');
      expect(self.fetch.args[1][0].integrity).to.eql('sha256-second');
    });

    it(`should fail when entries have the same url but different integrity`, function() {
      return expectError(() => {
        const precacheController = new PrecacheController();
        const cacheList = [
          {url: '/test', integrity: 'sha256-one'},
          {url: '/test', integrity: 'sha256-two'},
        ];
        precacheController.addToCacheList(cacheList);
      }, 'add-to-cache-list-conflicting-integrities', (err) => {
        expect(err.details.url).to.eql(`${location.origin}/test`);
      });
    });

    it(`should fail installation when a response with a status of 400 is received`, async function() {
      self.fetch.restore();
      sandbox.stub(self, 'fetch').resolves(new Response('', {
        status: 400,
      }));

      const precacheController = new PrecacheController();
      const cacheList = [
        '/will-be-error.html',
      ];
      precacheController.addToCacheList(cacheList);

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      return expectError(
          () => precacheController.install({event}),
          'bad-precaching-response',
      );
    });

    it(`should successfully install when an opaque response is received`, async function() {
      self.fetch.restore();
      sandbox.stub(self, 'fetch').callsFake(() => {
        const response = new Response('opaque');
        sandbox.stub(response, 'status').value(0);
        return response;
      });

      const precacheController = new PrecacheController();
      const cacheList = [
        '/will-be-opaque.html',
      ];
      precacheController.addToCacheList(cacheList);

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      // This should succeed.
      await precacheController.install({event});
    });

    it(`should successfully install when a response with a status of 400 is received, if a cacheWillUpdate plugin allows it`, async function() {
      self.fetch.restore();
      sandbox.stub(self, 'fetch').resolves(new Response('', {
        status: 400,
      }));

      const precacheController = new PrecacheController();
      const cacheList = [
        '/will-be-error.html',
      ];
      precacheController.addToCacheList(cacheList);

      const plugins = [{
        cacheWillUpdate: ({request, response}) => {
          if (response.status === 400) {
            return response;
          }
          return null;
        },
      }];

      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      // This should succeed.
      await precacheController.install({event, plugins});
    });
  });

  describe(`activate()`, function() {
    it(`should remove out of date entry`, async function() {
      const cache = await caches.open(cacheNames.getPrecacheName());
      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      // First precache some entries.
      const precacheControllerOne = new PrecacheController();
      const cacheList1 = [
        {url: '/scripts/index.js', revision: '1234'},
      ];
      precacheControllerOne.addToCacheList(cacheList1);
      await precacheControllerOne.install({event});

      const cleanupDetailsOne = await precacheControllerOne.activate();
      expect(cleanupDetailsOne.deletedURLs.length).to.equal(0);

      const precacheControllerTwo = new PrecacheController();
      const cacheListTwo = [];
      precacheControllerTwo.addToCacheList(cacheListTwo);
      await precacheControllerTwo.install({event});

      const cleanupDetailsTwo = await precacheControllerTwo.activate();
      expect(cleanupDetailsTwo.deletedURLs.length).to.equal(1);
      expect(cleanupDetailsTwo.deletedURLs[0]).to.eql(`${location.origin}/scripts/index.js?__WB_REVISION__=1234`);

      const keysTwo = await cache.keys();
      expect(keysTwo.length).to.equal(cacheListTwo.length);
    });

    it(`should remove out of date entries`, async function() {
      const cache = await caches.open(cacheNames.getPrecacheName());
      const event = new ExtendableEvent('install');
      spyOnEvent(event);

      // First, precache some entries.
      const precacheControllerOne = new PrecacheController();
      const cacheList1 = [
        '/index.1234.html',
        {url: '/example.1234.css'},
        {url: '/scripts/index.js', revision: '1234'},
        {url: '/scripts/stress.js?test=search&foo=bar', revision: '1234'},
      ];
      precacheControllerOne.addToCacheList(cacheList1);
      await precacheControllerOne.install({event});

      if (process.env.NODE_ENV !== 'production') {
        // Reset, as addToCacheList and install will log.
        logger.log.resetHistory();
      }

      const cleanupDetailsOne = await precacheControllerOne.activate();
      expect(cleanupDetailsOne.deletedURLs.length).to.equal(0);

      // Then, precache the same URLs, but two with different revisions.
      const precacheControllerTwo = new PrecacheController();
      const cacheListTwo = [
        '/index.4321.html',
        {url: '/example.1234.css'},
        {url: '/scripts/index.js', revision: '1234'},
        {url: '/scripts/stress.js?test=search&foo=bar', revision: '4321'},
      ];
      precacheControllerTwo.addToCacheList(cacheListTwo);
      await precacheControllerTwo.install({event});

      if (process.env.NODE_ENV !== 'production') {
        // Reset as addToCacheList and install will log.
        logger.log.resetHistory();
      }

      const cleanupDetailsTwo = await precacheControllerTwo.activate();
      expect(cleanupDetailsTwo.deletedURLs).to.have.members([
        `${location.origin}/index.1234.html`,
        `${location.origin}/scripts/stress.js?test=search&foo=bar&__WB_REVISION__=1234`,
      ]);

      const keysTwo = await cache.keys();
      expect(keysTwo.length).to.equal(cacheListTwo.length);

      const expectedCacheKeys2 = [
        `${location.origin}/index.4321.html`,
        `${location.origin}/example.1234.css`,
        `${location.origin}/scripts/index.js?__WB_REVISION__=1234`,
        `${location.origin}/scripts/stress.js?test=search&foo=bar&__WB_REVISION__=4321`,
      ];
      for (const key of expectedCacheKeys2) {
        const cachedResponse = await cache.match(key);
        expect(cachedResponse, `${key} is not cached`).to.exist;
      }

      // Make sure we print some log info.
      if (process.env.NODE_ENV !== 'production') {
        expect(logger.log.callCount).to.be.gt(0);
      }
    });
  });

  describe(`getCachedURLs()`, function() {
    it(`should return the cached URLs`, function() {
      const precacheController = new PrecacheController();
      const cacheList = [
        '/index.1234.html',
        {url: '/example.1234.css'},
        {url: '/scripts/index.js', revision: '1234'},
        {url: '/scripts/stress.js?test=search&foo=bar', revision: '1234'},
      ];
      precacheController.addToCacheList(cacheList);

      const urls = precacheController.getCachedURLs();
      expect(urls).to.deep.equal([
        new URL('/index.1234.html', location).toString(),
        new URL('/example.1234.css', location).toString(),
        new URL('/scripts/index.js', location).toString(),
        new URL('/scripts/stress.js?test=search&foo=bar', location).toString(),
      ]);
    });
  });
});
