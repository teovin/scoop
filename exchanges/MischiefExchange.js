/**
 * Mischief
 * @module exchanges.MischiefExchange
 * @author The Harvard Library Innovation Lab
 * @license MIT
 * @description Parent class for HTTP exchanges captured by Mischief.
*/

/**
 * Represents an HTTP exchange captured by Mischief, irrespective of how it was captured.
 * To be specialized by interception type (i.e: MischiefProxyExchange).
 */
export class MischiefExchange {
  /** @type {Date} */
  date = new Date();

  /** @type {?string} */
  id;

  /** @type {object} */
  _request;

  set request(val) {
    this._request = val;
  }

  get request() {
    return this._request;
  }

  /** @type {?object} */
  _response;

  set response(val) {
    this._response = val;
  }

  get response() {
    return this._response;
  }

  /**
   * @param {object} props - Object containing any of the properties of `this`.
   */
  constructor(props = {}) {
    for (const [key, value] of Object.entries(props)) {
      if (key in this) {
        this[key] = value;
      }
    }
  }
}