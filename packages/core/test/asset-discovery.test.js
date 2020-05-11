import os from 'os';
import path from 'path';
import expect from 'expect';
import Percy from '../src';
import { mockAPI, createTestServer, dedent, stdio } from './helpers';
import { sha256hash } from '@percy/client/dist/utils';

describe('Asset Discovery', () => {
  let percy, server, captured;

  let testDOM = dedent`
    <html>
    <head><link href="style.css" rel="stylesheet"/></head>
    <body>
      <p>Hello Percy!<p><img src="img.gif" decoding="async"/>
      ${' '.repeat(1000)}
    </body>
    </html>
  `;

  let testCSS = dedent`
    p { color: purple; }
  `;

  // http://png-pixel.com/
  let pixel = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

  beforeEach(async () => {
    captured = [];

    mockAPI.reply('/builds/123/snapshots', ({ body }) => {
      captured.push(
        // order is not important, stabilize it for testing
        body.data.relationships.resources.data
          .sort((a, b) => a.id < b.id ? -1 : (a.id > b.id ? 1 : 0))
      );

      return [201, { data: { id: '4567' } }];
    });

    server = await createTestServer();

    server.app
      .get('/', (req, res) => {
        res.set('Content-Type', 'text/html').send(testDOM);
      })
      .get('/style.css', (req, res) => {
        res.set('Content-Type', 'text/css').send(testCSS);
      })
      .get('/img.gif', (req, res) => setTimeout(() => {
        res.set('Content-Type', 'image/gif').send(pixel);
      }, 10));

    percy = await Percy.start({
      token: 'PERCY_TOKEN',
      snapshot: { widths: [1000] },
      discovery: { concurrency: 1 }
    });
  });

  afterEach(async () => {
    percy?.loglevel('error');
    await percy?.stop();
    server.close();
  });

  it('gathers resources for a snapshot', async () => {
    await percy.snapshot({
      name: 'test snapshot',
      url: 'http://localhost:8000',
      domSnapshot: testDOM
    });

    let paths = server.requests.map(r => r.path);
    // does not request the root url (serves domSnapshot instead)
    expect(paths).not.toContain('/');
    expect(paths).toContain('/style.css');
    expect(paths).toContain('/img.gif');

    expect(captured[0]).toEqual([
      expect.objectContaining({
        id: sha256hash(testDOM),
        attributes: expect.objectContaining({
          'resource-url': 'http://localhost:8000/'
        })
      }),
      expect.objectContaining({
        id: sha256hash(testCSS),
        attributes: expect.objectContaining({
          'resource-url': 'http://localhost:8000/style.css'
        })
      }),
      expect.objectContaining({
        id: sha256hash(pixel),
        attributes: expect.objectContaining({
          'resource-url': 'http://localhost:8000/img.gif'
        })
      })
    ]);
  });

  it('does not capture prefetch requests', async () => {
    let prefetchDOM = testDOM.replace('stylesheet', 'prefetch');

    await percy.snapshot({
      name: 'test snapshot',
      url: 'http://localhost:8000',
      domSnapshot: prefetchDOM
    });

    let paths = server.requests.map(r => r.path);
    expect(paths).toContain('/style.css');

    expect(captured[0]).toEqual([
      expect.objectContaining({
        id: sha256hash(pixel),
        attributes: expect.objectContaining({
          'resource-url': 'http://localhost:8000/img.gif'
        })
      }),
      expect.objectContaining({
        id: sha256hash(prefetchDOM),
        attributes: expect.objectContaining({
          'resource-url': 'http://localhost:8000/'
        })
      })
    ]);
  });

  it('does not capture data url requests', async () => {
    let dataUrl = `data:image/gif;base64,${pixel.toString('base64')}`;
    let dataUrlDOM = testDOM.replace('img.gif', dataUrl);

    await percy.snapshot({
      name: 'test snapshot',
      url: 'http://localhost:8000',
      domSnapshot: dataUrlDOM
    });

    expect(captured[0]).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        attributes: expect.objectContaining({
          'resource-url': dataUrl.replace('data:', 'data://')
        })
      })
    ]));
  });

  it('follows redirects', async () => {
    server.app.get('/stylesheet.css', (req, res) => {
      res.redirect('/style.css');
    });

    await percy.snapshot({
      name: 'test snapshot',
      url: 'http://localhost:8000',
      domSnapshot: testDOM.replace('style.css', 'stylesheet.css')
    });

    let paths = server.requests.map(r => r.path);
    expect(paths).toContain('/stylesheet.css');
    expect(paths).toContain('/style.css');

    expect(captured[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: sha256hash(testCSS),
        attributes: expect.objectContaining({
          'resource-url': 'http://localhost:8000/stylesheet.css'
        })
      })
    ]));
  });

  it('skips capturing large files', async () => {
    server.app.get('/large.css', (req, res) => {
      res.set('Content-Type', 'text/stylesheet').send('A'.repeat(16000000));
    });

    percy.loglevel('debug');
    await stdio.capture(() => (
      percy.snapshot({
        name: 'test snapshot',
        url: 'http://localhost:8000',
        domSnapshot: testDOM.replace('style.css', 'large.css')
      })
    ));

    expect(captured[0]).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          'resource-url': 'http://localhost:8000/'
        })
      }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          'resource-url': 'http://localhost:8000/img.gif'
        })
      })
    ]);

    expect(stdio[1]).toContain(
      '[percy] Skipping - Max file size exceeded [15.3MB]\n'
    );
  });

  it('logs detailed debug logs', async () => {
    percy.loglevel('debug');
    await stdio.capture(() => (
      percy.snapshot({
        name: 'test snapshot',
        url: 'http://localhost:8000',
        domSnapshot: testDOM,
        clientInfo: 'test client info',
        environmentInfo: 'test env info',
        widths: [400, 1200]
      })
    ));

    expect(stdio[2]).toHaveLength(0);
    expect(stdio[1]).toEqual(expect.arrayContaining([
      '[percy] ---------\n',
      '[percy] Handling snapshot:\n',
      '[percy] -> name: test snapshot\n',
      '[percy] -> url: http://localhost:8000/\n',
      '[percy] -> widths: 400px, 1200px\n',
      '[percy] -> clientInfo: test client info\n',
      '[percy] -> environmentInfo: test env info\n',
      '[percy] -> requestHeaders: {}\n',
      `[percy] -> domSnapshot:\n${testDOM.substr(0, 1024)}... [truncated]\n`,
      '[percy] Discovering resources @400px for http://localhost:8000/\n',
      '[percy] Handling request for http://localhost:8000/\n',
      '[percy] Serving root resource for http://localhost:8000/\n',
      '[percy] Handling request for http://localhost:8000/style.css\n',
      '[percy] Handling request for http://localhost:8000/img.gif\n',
      '[percy] Processing resource - http://localhost:8000/style.css\n',
      '[percy] Making local copy of response - http://localhost:8000/style.css\n',
      '[percy] -> url: http://localhost:8000/style.css\n',
      `[percy] -> sha: ${sha256hash(testCSS)}\n`,
      `[percy] -> filepath: ${path.join(os.tmpdir(), 'percy', sha256hash(testCSS))}\n`,
      '[percy] -> mimetype: text/css\n',
      '[percy] Processing resource - http://localhost:8000/img.gif\n',
      '[percy] Making local copy of response - http://localhost:8000/img.gif\n',
      '[percy] -> url: http://localhost:8000/img.gif\n',
      `[percy] -> sha: ${sha256hash(pixel)}\n`,
      `[percy] -> filepath: ${path.join(os.tmpdir(), 'percy', sha256hash(pixel))}\n`,
      '[percy] -> mimetype: image/gif\n',
      '[percy] Discovering resources @1200px for http://localhost:8000/\n',
      '[percy] Handling request for http://localhost:8000/\n',
      '[percy] Serving root resource for http://localhost:8000/\n',
      '[percy] Handling request for http://localhost:8000/style.css\n',
      '[percy] Response cache hit for http://localhost:8000/style.css\n',
      '[percy] Handling request for http://localhost:8000/img.gif\n',
      '[percy] Response cache hit for http://localhost:8000/img.gif\n',
      '[percy] Snapshot taken: test snapshot\n'
    ]));
  });

  it('logs failed request errors with a debug loglevel', async () => {
    percy.loglevel('debug');
    await stdio.capture(() => (
      percy.snapshot({
        name: 'test snapshot',
        url: 'http://localhost:8000',
        domSnapshot: testDOM.replace('style.css', '/404/style.css')
      })
    ));

    expect(stdio[2]).toHaveLength(0);
    expect(stdio[1]).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(
        '^\\[percy\\] Request failed for http://localhost:8000/404/style\\.css - net::'
      ))
    ]));
  });

  describe('resource caching', () => {
    let snapshot = async n => {
      await percy.snapshot({
        name: `test snapshot ${n}`,
        url: 'http://localhost:8000',
        domSnapshot: testDOM
      });
    };

    it('caches resource requests', async () => {
      // take two snapshots
      await snapshot(1);
      await snapshot(2);

      // only one request for each resource should be made
      let paths = server.requests.map(r => r.path);
      expect(paths.sort()).toEqual(['/img.gif', '/style.css']);

      // the first and second snapshot's captured resources should match
      expect(captured[0]).toEqual(captured[1]);
    });

    it('does not cache resource requests when disabled', async () => {
      percy.discoverer.disableAssetCache = true;

      // repeat above test
      await snapshot(1);
      await snapshot(2);

      // two requests for each resource should be made (opposite of prev test)
      let paths = server.requests.map(r => r.path);
      expect(paths.sort()).toEqual(['/img.gif', '/img.gif', '/style.css', '/style.css']);

      // the first and second snapshot's captured resources should match
      expect(captured[0]).toEqual(captured[1]);
    });
  });

  // these caches helpers are no longer used
  describe('with unhandled errors', async () => {
    it('logs unhandled request errors gracefully', async () => {
      // sabotage this property to trigger unexpected error handling
      Object.defineProperty(percy.discoverer, 'disableAssetCache', {
        get() { throw new Error('some unhandled request error'); }
      });

      await stdio.capture(() => (
        percy.snapshot({
          name: 'test snapshot',
          url: 'http://localhost:8000',
          domSnapshot: testDOM
        })
      ));

      expect(stdio[1]).toHaveLength(0);
      expect(stdio[2]).toEqual([
        '[percy] Encountered an error for http://localhost:8000/style.css\n',
        '[percy] Error: some unhandled request error\n',
        '[percy] Encountered an error for http://localhost:8000/img.gif\n',
        '[percy] Error: some unhandled request error\n'
      ]);
    });

    it('logs unhandled requestfinished errors gracefully', async () => {
      // sabotage this method to trigger unexpected error handling
      percy.discoverer._parseRequestResponse = url => {
        throw new Error('some unhandled finished error');
      };

      await stdio.capture(() => (
        percy.snapshot({
          name: 'test snapshot',
          url: 'http://localhost:8000',
          domSnapshot: testDOM
        })
      ));

      expect(stdio[1]).toHaveLength(0);
      expect(stdio[2]).toEqual([
        '[percy] Encountered an error for http://localhost:8000/style.css\n',
        '[percy] Error: some unhandled finished error\n',
        '[percy] Encountered an error for http://localhost:8000/img.gif\n',
        '[percy] Error: some unhandled finished error\n'
      ]);
    });
  });

  describe('with external assets', () => {
    let testExternalDOM = testDOM.replace('img.gif', 'http://test.localtest.me:8001/img.gif');
    let server2;

    beforeEach(async () => {
      server2 = await createTestServer(8001);
      server2.app.get('/img.gif', (req, res) => {
        res.set('Content-Type', 'image/gif').send(pixel);
      });
    });

    afterEach(() => {
      server2.close();
    });

    it('does not request or capture external assets', async () => {
      await percy.snapshot({
        name: 'test snapshot',
        url: 'http://localhost:8000',
        domSnapshot: testExternalDOM
      });

      let paths = server.requests.map(r => r.path);
      expect(paths).toContain('/style.css');
      expect(paths).not.toContain('/img.gif');
      let paths2 = server2.requests.map(r => r.path);
      expect(paths2).not.toContain('/img.gif');

      expect(captured[0]).toEqual([
        expect.objectContaining({
          attributes: expect.objectContaining({
            'resource-url': 'http://localhost:8000/style.css'
          })
        }),
        expect.objectContaining({
          attributes: expect.objectContaining({
            'resource-url': 'http://localhost:8000/'
          })
        })
      ]);
    });

    it('captures assets from allowed hostnames', async () => {
      // stop current instance to create a new one
      await percy.stop();

      percy = await Percy.start({
        token: 'PERCY_TOKEN',
        discovery: {
          allowedHostnames: ['*.localtest.me']
        }
      });

      await percy.snapshot({
        name: 'test snapshot',
        url: 'http://localhost:8000',
        domSnapshot: testExternalDOM,
        widths: [1000]
      });

      expect(captured[0][2]).toEqual(
        expect.objectContaining({
          attributes: expect.objectContaining({
            'resource-url': 'http://test.localtest.me:8001/img.gif'
          })
        })
      );
    });

    it('captures assets from wildcard hostnames', async () => {
      // stop current instance to create a new one
      await percy.stop();

      percy = await Percy.start({
        token: 'PERCY_TOKEN',
        discovery: {
          allowedHostnames: ['*']
        }
      });

      await percy.snapshot({
        name: 'test snapshot',
        url: 'http://localhost:8000',
        domSnapshot: testExternalDOM,
        widths: [1000]
      });

      expect(captured[0][2]).toEqual(
        expect.objectContaining({
          attributes: expect.objectContaining({
            'resource-url': 'http://test.localtest.me:8001/img.gif'
          })
        })
      );
    });

    it('does nothing for empty allowed hostnames', async () => {
      // stop current instance to create a new one
      await percy.stop();

      percy = await Percy.start({
        token: 'PERCY_TOKEN',
        discovery: {
          allowedHostnames: ['']
        }
      });

      await percy.snapshot({
        name: 'test snapshot',
        url: 'http://localhost:8000',
        domSnapshot: testExternalDOM,
        widths: [1000]
      });

      expect(captured[0]).toEqual([
        expect.objectContaining({
          attributes: expect.objectContaining({
            'resource-url': 'http://localhost:8000/style.css'
          })
        }),
        expect.objectContaining({
          attributes: expect.objectContaining({
            'resource-url': 'http://localhost:8000/'
          })
        })
      ]);
    });
  });
});