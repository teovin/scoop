/**
 * Mischief
 * @module exporters.mischiefToWacz
 * @author The Harvard Library Innovation Lab
 * @license MIT
 * @description Mischief to WACZ exporter.
 */

import { Mischief } from "../Mischief.js";
import { WACZ, mischiefExchangeToPageLine } from "../utils/WACZ.js";

/**
 * Mischief capture to WACZ converter.
 *
 * Note:
 * - Logs are added to capture object via `Mischief.addToLogs()`.
 *
 * @param {Mischief} capture
 * @param {boolean} includeRaw - If `true`, includes the raw http exchanges in the WACZ.
 * @returns {Promise<ArrayBuffer>}
 */
export async function mischiefToWacz(capture, includeRaw = false) {
  const validStates = [Mischief.states.PARTIAL, Mischief.states.COMPLETE];

  if (!(capture instanceof Mischief) || !validStates.includes(capture.state)) {
    throw new Error("`capture` must be a partial or complete Mischief object.");
  }

  const wacz = new WACZ();

  // Append WARC
  wacz.files['archive/data.warc'] = Buffer.from(await capture.toWarc())

  // Append extra `datapackage.json` info:
  if (capture.options.provenanceSummary && capture.provenanceInfo) {
    wacz.datapackageExtras = {"provenanceInfo": capture.provenanceInfo};
  }

  // Append raw exchanges
  if (includeRaw) {
    capture.exchanges.forEach((exchange) => {
      ['request', 'response'].forEach((type) => {
        const data = exchange[`${type}Raw`];
        if (data) {
          wacz.files[`raw/${type}_${exchange.date.toISOString()}_${exchange.id}`] = data;
        }
      })
    })
  }

  // Generate entry points (exchanges added to `pages.jsonl`).
  let entryPoints = [];

  if (capture.exchanges.length > 0) {
    entryPoints.push(capture.exchanges[0]); // the first exchange is our entrypoint url for the entire crawl
  }

  for (let exchange of capture.generatedExchanges) {
    if (exchange?.isEntryPoint && exchange.isEntryPoint === true) {
      entryPoints.push(exchange);
    }
  }

  wacz.pages = entryPoints.map(mischiefExchangeToPageLine)

  return await wacz.finalize();
}
