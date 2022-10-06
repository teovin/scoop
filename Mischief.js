/**
 * Mischief
 * @module Mischief
 * @author The Harvard Library Innovation Lab
 * @license MIT
 */
import { chromium } from "playwright";
import ProxyServer from "transparent-proxy";

import * as browserScripts from "./browser-scripts/index.js";
import * as exporters from "./exporters/index.js";
import { MischiefExchange } from "./MischiefExchange.js";
import { MischiefLog } from "./MischiefLog.js";
import { MischiefOptions } from "./MischiefOptions.js";

/**
 * Experimental single-page web archiving solution using Playwright.
 * - Uses a proxy to allow for comprehensive and raw network interception.
 * 
 * Usage:
 * ```javascript
 * import { Mischief } from "mischief";
 * 
 * const myCapture = new Mischief(url, options);
 * await myCapture.capture();
 * if (myCapture.success === true) {
 *   const warc = await myCapture.toWarc(); // Returns an ArrayBuffer
 * }
 * ```
 */
export class Mischief {
  /**
   * Enum-like states that the capture occupies.
   * @type {object}
   */
  static states = Object.freeze({
    INIT: 0,
    SETUP: 1,
    CAPTURE: 2,
    TEARDOWN: 3,
    COMPLETE: 4,
    PARTIAL: 5,
    ERROR: 6
  });

  /**
   * Current state of the capture.
   * Should only contain states defined in `states`.
   * @type {number}
   */
  state = Mischief.states.INIT;

  /**
   * URL to capture.
   * @type {string} 
   */
  url = "";

  /** 
   * Current settings. 
   * Should only contain keys defined in `MischiefOptions`.
   * @type {object} 
   */
  options = {};

  /**
   * Array of HTTP exchanges that constitute the capture.
   * @type {MischiefExchange[]}
   */
  exchanges = [];

  /** @type {MischiefLog[]} */
  logs = [];

  /**
   * Total size of recorded exchanges, in bytes.
   * @type {number}
   */
  totalSize = 0;

  /**
   * The Playwright browser instance for this capture.
   * @type {Browser}
   */
  #browser;

  /**
   * @param {string} url - Must be a valid HTTP(S) url.
   * @param {object} [options={}] - See `MischiefOptions` for details.
   */
  constructor(url, options = {}) {
    this.url = this.filterUrl(url);
    this.options = this.filterOptions(options);
    this.networkInterception = this.networkInterception.bind(this);
  }

  /**
   * Main capture process.
   * 
   * Separated in two main phases:
   * - In-browser capture - during which Mischief will try to intercept as many HTTP exchanges as possible and identify elements it cannot capture that way.
   * - Fallback out-of-browser capture - during which Mischief runs Fetch requests to capture elements that could not be intercepted earlier.
   *  
   * @returns {Promise<boolean>}
   */
  async capture() {
    const options = this.options;
    const steps = [];

    steps.push({
      name: "initial load",
      fn: async (page) => { await page.goto(this.url, { waitUntil: "load", timeout: options.loadTimeout }); }
    });

    if (options.grabSecondaryResources ||
        options.autoPlayMedia ||
        options.runSiteSpecificBehaviors){
      steps.push({
        name: "browser scripts",
        fn: async (page) => {
          await page.addInitScript({ path: './node_modules/browsertrix-behaviors/dist/behaviors.js' });
          await page.addInitScript({
            content: `
              self.__bx_behaviors.init({
                autofetch: ${options.grabSecondaryResources},
                autoplay: ${options.autoPlayMedia},
                siteSpecific: ${options.runSiteSpecificBehaviors},
                timeout: ${options.behaviorsTimeout}
              });`
          });
          await Promise.allSettled(page.frames().map(frame => frame.evaluate("self.__bx_behaviors.run()")));
        }
      });
    }

    if (options.autoScroll === true) {
      steps.push({
        name: "auto-scroll",
        fn: async (page) => { await page.evaluate(browserScripts.autoScroll, {timeout: options.autoScrollTimeout}); }
      });
    }

    if (options.screenshot) {
      steps.push({
        name: "screenshot",
        fn: async (page) => {
          this.exchanges.push(new MischiefExchange({
            url: "file:///screenshot.png",
            response: {
              headers: ["Content-Type", "image/png"],
              versionMajor: 1,
              versionMinor: 1,
              statusCode: 200,
              statusMessage: "OK",
              body: await page.screenshot({fullPage: true})
            }
          }));
        }
      });
    }

    steps.push({
      name: "network idle",
      fn: async (page) => { await page.waitForLoadState("networkidle", {timeout: options.networkIdleTimeout}); }
    });

    const page = await this.setup();
    this.addToLogs(`Starting capture of ${this.url} with options: ${JSON.stringify(options)}`);
    this.state = Mischief.states.CAPTURE;

    let i = 0;
    do {
      const step = steps[i];
      try {
        this.addToLogs(`STEP [${i+1}/${steps.length}]: ${step.name}`);
        await step.fn(page);
      } catch(err) {
        if(this.state == Mischief.states.CAPTURE){
          this.addToLogs(`STEP [${i+1}/${steps.length}]: ${step.name} - failed`, true, err);
        } else {
          this.addToLogs(`STEP [${i+1}/${steps.length}]: ${step.name} - ended due to max size reached`, true);
        }
      }
    } while(this.state == Mischief.states.CAPTURE && i++ < steps.length-1);

    await this.teardown(page);
    return this.state = Mischief.states.COMPLETE;
  }

  /**
   * Sets up the proxy and Playwright resources
   *
   * @returns {Promise<boolean>}
   */
  async setup(){
    this.state = Mischief.states.SETUP;
    const options = this.options;

    const proxy = new ProxyServer({
      intercept: true,
      verbose: options.proxyVerbose,
      injectData: (data, session) => this.networkInterception("request", data, session),
      injectResponse: (data, session) => this.networkInterception("response", data, session)
    });
    proxy.listen(options.proxyPort, options.proxyHost, () => {
      console.log('TCP-Proxy-Server started!', proxy.address());
    });

    this.#browser = await chromium.launch({
      headless: options.headless,
      channel: "chrome",
      proxy: {server: `http://${options.proxyHost}:${options.proxyPort}`}
    })
    this.#browser.on('disconnected', () => proxy.close());

    const context = await this.#browser.newContext({ignoreHTTPSErrors: true});
    const page = await context.newPage();

    page.setViewportSize({
      width: options.captureWindowX,
      height: options.captureWindowY,
    });

    return page;
  }

  /**
   * Tears down the Playwright and (via event listener) the proxy resources.
   *
   * @returns {Promise<boolean>}
   */
  async teardown(){
    if(this.state == Mischief.states.TEARDOWN) { return; }
    this.state = Mischief.states.TEARDOWN;
    this.addToLogs("Closing browser and proxy server.");
    await this.#browser.close();
  }

  /**
   * Returns an exchange based on the session id and type ("request" or "response").
   * If the type is a request and there's already been a response on that same session,
   * create a new exchange. Otherwise append to continue the exchange.
   *
   * @param {string} id
   * @param {string} type
   */
  getOrInitExchange(id, type) {
    return this.exchanges.findLast((ex) => {
      return ex.id == id && (type == "response" || !ex.responseRaw);
    }) || this.exchanges[this.exchanges.push(new MischiefExchange({id: id})) - 1];
  }

  /**
   * Collates network data (both requests and responses) from the proxy.
   * Capture size enforcement happens here.
   *
   * @param {string} type
   * @param {Buffer} data
   * @param {Session} session
   */
  networkInterception(type, data, session) {
    const ex = this.getOrInitExchange(session._id, type);
    const prop = `${type}Raw`;
    ex[prop] = ex[prop] ? Buffer.concat([ex[prop], data], ex[prop].length + data.length) : data;

    this.totalSize += data.byteLength;
    if(this.totalSize >= this.options.maxSize && this.state == Mischief.states.CAPTURE){
      this.addToLogs("Max size reached. Ending further capture.");
      this.teardown();
    }
    return data;
  }

  /**
   * Creates and stores a log entry.
   * Will automatically be printed to STDOUT if `this.options.verbose` is `true`.
   * 
   * @param {string} message 
   * @param {boolean} [isWarning=false] 
   * @param {string} [trace=""] 
   */
  addToLogs(message, isWarning = false, trace = "") {
    const log = new MischiefLog(message, isWarning, trace, this.options.verbose);
    this.logs.push(log);
  }

  /**
   * Filters a url to ensure it's suitable for capture.
   * This function throws if:
   * - `url` is not a valid url
   * - `url` is not an http / https url
   * 
   * @param {string} url 
   */
  filterUrl(url) {
    try {
      let filteredUrl = new URL(url); // Will throw if not a valid url

      if (filteredUrl.protocol !== "https:" && filteredUrl.protocol !== "http:") {
        throw new Error("Invalid protocol.");
      }
      
      return filteredUrl.href;
    }
    catch(err) {
      throw new Error(`Invalid url provided.\n${err}`);
    }
  }

  /**
   * Filters an options object by comparing it with `MischiefOptions`.
   * Will use defaults for missing properties.
   * 
   * @param {object} newOptions 
   */
  filterOptions(newOptions) {
    const options = {};

    for (let key of Object.keys(MischiefOptions)) {
      options[key] = key in newOptions ? newOptions[key] : MischiefOptions[key];

      // Apply basic type casting based on type of defaults (MischiefOptions)
      switch (typeof MischiefOptions[key]) {
        case "boolean":
          options[key] = Boolean(options[key]);
        break;

        case "number":
          options[key] = Number(options[key]);
        break;

        case "string":
          options[key] = String(options[key]);
        break;
      }
    }

    return options;
  }

  /**
   * Export capture to WARC.
   * @param {boolean} [gzip=false] - If `true`, will be compressed using GZIP (for `.warc.gz`). 
   * @returns {Promise<ArrayBuffer>} - Binary data ready to be saved a .warc or .warc.gz
   */
  async toWarc(gzip=false) {
    return await exporters.warc(this, gzip);
  }

}
