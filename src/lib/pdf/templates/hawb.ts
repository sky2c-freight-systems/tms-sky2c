import type { HawbData } from "@/lib/pdf/hawbData";
import { escapeHtml } from "@/lib/pdf/templates/shared";

/**
 * House Air Waybill — laid out after Sky2C's HAWB: three originals (Airline, Consignee,
 * Shipper), each followed by the IATA conditions-of-contract page. Data comes from
 * src/lib/pdf/hawbData.ts.
 *
 * Shipper / Consignee Code are the TMS Client IDs of the shipment's Shipper / Consignee.
 * Boxes with no Shipment/Zoho field behind them are printed empty for hand-fill:
 * Account No., the destination agent in Accounting
 * Information, routing (To / By First Carrier / to / by), WT/VAL and Other P/C, Flight/Date,
 * Handling Information, Rate Class, Commodity Item No., HS Code, AES/ITN, the charge boxes
 * and the place of execution. Constants: Sky2C as issuing agent with its IATA code,
 * NVD / NCV declared values, "XXX" insurance and "AS AGREED" total.
 */

const ISSUING_AGENT = ["SKY 2 C FREIGHT SYSTEMS, INC", "1500 ATLANTIC ST", "UNION CITY, CA 94587"];
const AGENT_IATA_CODE = "01126990012";
const COPIES = ["ORIGINAL FOR AIRLINE", "ORIGINAL FOR CONSIGNEE", "ORIGINAL FOR SHIPPER"];

const CARRIAGE_NOTICE =
  "It is agreed that the goods described herein are accepted in apparent good order and condition (except as noted) for carriage " +
  "SUBJECT TO THE CONDITIONS OF CONTRACT ON THE REVERSE HEREOF. ALL GOODS MAY BE CARRIED BY ANY OTHER MEANS INCLUDING ROAD OR ANY " +
  "OTHER CARRIER UNLESS SPECIFIC CONTRARY INSTRUCTIONS ARE GIVEN HEREON BY THE SHIPPER, AND SHIPPER AGREES THAT THE SHIPMENT MAY " +
  "BE CARRIED VIA INTERMEDIATE STOPPING PLACES WHICH THE CARRIER DEEMS APPROPRIATE. THE SHIPPER'S ATTENTION IS DRAWN TO THE NOTICE " +
  "CONCERNING CARRIER'S LIMITATION OF LIABILITY. Shipper may increase such limitation of liability by declaring a higher value for " +
  "carriage and paying a supplemental charge if required.";

function text(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, "<br/>");
}

function lines(values: string[]): string {
  return values.map((v) => escapeHtml(v)).join("<br/>");
}

function facePage(d: HawbData, copy: string): string {
  return `
<section class="page face">
  <div class="mawb">${escapeHtml(d.masterAwb)}</div>
  <table class="grid">
    <colgroup><col style="width:26%"/><col style="width:24%"/><col style="width:50%"/></colgroup>
    <tr>
      <td class="tall">
        <span class="lbl">Shipper</span>
        <div class="v">${text(d.shipper)}</div>
      </td>
      <td class="tall"><span class="lbl">Shipper Code</span><div class="v">${escapeHtml(d.shipperCode)}</div></td>
      <td class="tall nopad">
        <div class="awb-head">
          <div class="nn"><span class="lbl">Not Negotiable</span><b>Air Waybill</b><span class="lbl c">Issued by</span></div>
          <div class="hawb-no"><b>House AWB#</b> <span class="v">${escapeHtml(d.hawbNumber)}</span></div>
        </div>
        <div class="v issued">${escapeHtml(d.issuedBy)}</div>
        <div class="copies">Copies 1, 2 and 3 of this Air Waybill are originals and have the same validity.</div>
      </td>
    </tr>
    <tr>
      <td class="tall">
        <span class="lbl">Consignee</span>
        <div class="v">${text(d.consignee)}</div>
      </td>
      <td class="tall"><span class="lbl">Consignee Code</span><div class="v">${escapeHtml(d.consigneeCode)}</div></td>
      <td class="tall small">${escapeHtml(CARRIAGE_NOTICE)}</td>
    </tr>
    <tr>
      <td colspan="2"><span class="lbl">Issuing Carriers Agent Name and City</span><div class="v">${lines(ISSUING_AGENT)}</div></td>
      <td rowspan="3"><span class="lbl">Accounting Information</span><div class="v">${escapeHtml(d.hawbNumber)}</div></td>
    </tr>
    <tr>
      <td><span class="lbl">Agent's IATA Code</span><div class="v">${AGENT_IATA_CODE}</div></td>
      <td><span class="lbl">Account No.</span></td>
    </tr>
    <tr>
      <td colspan="2"><span class="lbl">Airport of Departure (Addr. of First Carrier) and Requested Routing</span><div class="v">${escapeHtml(d.departureAirport)}</div></td>
    </tr>
  </table>

  <table class="grid route">
    <tr>
      <td style="width:7%"><span class="lbl">To</span></td>
      <td style="width:17%"><span class="lbl">By First Carrier</span></td>
      <td style="width:6%"><span class="lbl">to</span></td>
      <td style="width:6%"><span class="lbl">by</span></td>
      <td style="width:6%"><span class="lbl">to</span></td>
      <td style="width:8%"><span class="lbl">by</span></td>
      <td style="width:8%"><span class="lbl">Currency</span><div class="v">${escapeHtml(d.currency)}</div></td>
      <td style="width:7%" class="c"><span class="lbl">WT/VAL</span><div class="pc"><span>P</span><span>C</span></div></td>
      <td style="width:7%" class="c"><span class="lbl">Other</span><div class="pc"><span>P</span><span>C</span></div></td>
      <td style="width:14%"><span class="lbl">Declared Value for Carriage</span><div class="v">NVD</div></td>
      <td style="width:14%"><span class="lbl">Declared Value for Customs</span><div class="v">NCV</div></td>
    </tr>
  </table>
  <table class="grid route">
    <tr>
      <td style="width:24%"><span class="lbl">Airport of Destination</span><div class="v">${escapeHtml(d.destinationAirport)}</div></td>
      <td style="width:13%"><span class="lbl">Flight/Date</span></td>
      <td style="width:13%"><span class="lbl">For Carrier Use Only &nbsp; Flight/Date</span></td>
      <td style="width:14%"><span class="lbl">Amount of Insurance</span><div class="v">XXX</div></td>
      <td class="small">INSURANCE - if carrier offers insurance and such insurance is requested in accordance with conditions on reverse hereof indicate amount to be insured in figures in box marked Amount of insurance.</td>
    </tr>
    <tr><td colspan="5" class="handling"><span class="lbl">Handling Information</span></td></tr>
    <tr>
      <td colspan="5">
        <div class="licence">
          <span>These commodities licensed by the U.S. for ultimate destination <b class="v">${escapeHtml(d.destinationCountry)}</b></span>
          <span>Diversion contrary to U.S. law prohibited</span>
        </div>
      </td>
    </tr>
  </table>

  <table class="grid cargo">
    <colgroup>
      <col style="width:8%"/><col style="width:10%"/><col style="width:3%"/><col style="width:9%"/><col style="width:11%"/>
      <col style="width:12%"/><col style="width:12%"/><col style="width:35%"/>
    </colgroup>
    <tr class="head">
      <td>No. of Pieces</td><td>Gross Weight</td><td>kg lb</td><td>Rate Class<br/>Commodity Item No.</td><td>Chargeable Weight</td>
      <td>Rate / Charge</td><td>Total</td><td>Nature and Quantity of Goods<br/>(incl. Dimensions or Volume)</td>
    </tr>
    <tr class="body">
      <td class="v">${escapeHtml(d.pieces)}${d.volumeM3 ? `<div class="m3">M3 = ${escapeHtml(d.volumeM3)}</div>` : ""}</td>
      <td class="v r">${escapeHtml(d.grossWeightKg)}</td>
      <td class="v c">${d.grossWeightKg ? "K" : ""}</td>
      <td></td>
      <td class="v r">${escapeHtml(d.chargeableWeightKg)}</td>
      <td></td>
      <td class="v c">AS AGREED</td>
      <td class="v">${lines(d.goods)}</td>
    </tr>
    <tr class="totals">
      <td class="v">${escapeHtml(d.pieces)}</td><td class="v r">${escapeHtml(d.grossWeightKg)}</td>
      <td></td><td></td><td></td><td></td><td></td><td></td>
    </tr>
  </table>

  <table class="grid charges">
    <colgroup><col style="width:21%"/><col style="width:21%"/><col style="width:58%"/></colgroup>
    <tr><td class="c"><span class="lbl">Prepaid &nbsp; Weight Charge</span></td><td class="c"><span class="lbl">Collect</span></td><td rowspan="3"><span class="lbl">Other Charges</span></td></tr>
    <tr><td colspan="2" class="c"><span class="lbl">Valuation Charge</span></td></tr>
    <tr><td colspan="2" class="c"><span class="lbl">Tax</span></td></tr>
    <tr>
      <td colspan="2" class="c"><span class="lbl">Total Other Charges Due Agent</span></td>
      <td rowspan="2" class="tiny">${escapeHtml(CARRIAGE_NOTICE)}<div class="v">${escapeHtml(ISSUING_AGENT[0])}</div></td>
    </tr>
    <tr><td colspan="2" class="c"><span class="lbl">Total Other Charges Due Carrier</span></td></tr>
    <tr><td colspan="2"></td><td class="sigline"><span class="lbl">Signature of Shipper or his Agent</span></td></tr>
    <tr>
      <td class="c"><span class="lbl">Total Prepaid</span></td><td class="c"><span class="lbl">Total Collect</span></td>
      <td><div class="exec v"><span>${escapeHtml(d.executedOn)}</span><span></span><span>${escapeHtml(d.signedBy)}</span></div></td>
    </tr>
    <tr>
      <td class="c"><span class="lbl">Currency Conversion Rates</span></td><td class="c"><span class="lbl">CC Charges in Dest Currency</span></td>
      <td><div class="exec lbl"><span>Executed on (date)</span><span>at (place)</span><span>Signature of Issuing Carrier or its Agent</span></div></td>
    </tr>
    <tr>
      <td class="c"><span class="lbl">For Carriers Use only at Destination</span></td><td class="c"><span class="lbl">Charges at Destination</span></td>
      <td class="foot-cell"><div class="foot"><span class="lbl">Total Collect Charges</span><div><div class="v">${escapeHtml(d.hawbNumber)}</div><b>${escapeHtml(copy)}</b></div></div></td>
    </tr>
  </table>
</section>`;
}

const CONDITIONS_LEFT = [
  ["1.", "In this contract and the Notices appearing hereon:<br/><br/>CARRIER includes the air carrier issuing this air waybill and all carriers that carry or undertake to carry the cargo or perform any other services related to such carriage.<br/><br/>SPECIAL DRAWING RIGHT (SDR) is a Special Drawing Right as defined by the International Monetary Fund.<br/><br/>WARSAW CONVENTION means whichever of the following instruments is applicable to the contract of carriage: the Convention for the Unification of Certain Rules Relating to International Carriage by Air, signed at Warsaw, 12 October 1929; that Convention as amended at The Hague on 28 September 1955; that Convention as amended at The Hague 1955 and by Montreal Protocol No. 1, 2, or 4 (1975) as the case may be.<br/><br/>MONTREAL CONVENTION means the Convention for the Unification of Certain Rules for International Carriage by Air, done at Montreal on 28 May 1999."],
  ["2.1", "Carriage is subject to the rules relating to liability established by the Warsaw Convention or the Montreal Convention unless such carriage is not \"international carriage\" as defined by the applicable Conventions."],
  ["2.2", "To the extent not in conflict with the foregoing, carriage and other related services performed by each Carrier are subject to:"],
  ["2.2.1", "applicable laws and government regulations;"],
  ["2.2.2", "provisions contained in the air waybill, Carrier's conditions of carriage and related rules, regulations, and timetables (but not the times of departure and arrival stated therein) and applicable tariffs of such Carrier, which are made part hereof, and which may be inspected at any airports or other cargo sales offices from which it operates regular services. When carriage is to/from the USA, the shipper and the consignee are entitled, upon request, to receive a free copy of the Carrier's conditions of carriage. The Carrier's conditions of carriage include, but are not limited to:"],
  ["2.2.2.1", "limits on the Carrier's liability for loss, damage or delay of goods, including fragile or perishable goods;"],
  ["2.2.2.2", "claims restrictions, including time periods within which shippers or consignees must file a claim or bring an action against the Carrier for its acts or omissions, or those of its agents;"],
  ["2.2.2.3", "rights, if any, of the Carrier to change the terms of the contract;"],
  ["2.2.2.4", "rules about Carrier's right to refuse to carry;"],
  ["2.2.2.5", "rights of the Carrier and limitations concerning delay or failure to perform service, including schedule changes, substitution of alternate Carrier or aircraft and rerouting."],
  ["3.", "The agreed stopping places (which may be altered by Carrier in case of necessity) are those places, except the place of departure and place of destination, set forth on the face hereof or shown in Carrier's timetables as scheduled stopping places for the route. Carriage to be performed hereunder by several successive Carriers is regarded as a single operation."],
  ["4.", "For carriage to which neither the Warsaw Convention nor the Montreal Convention applies, Carrier's liability limitation shall not be less than the per kilogram monetary limit set out in Carrier's tariffs or general conditions of carriage for cargo lost, damaged or delayed, provided that any such limitation of liability in an amount less than 17 SDR per kilogram will not apply for carriage to or from the United States."],
  ["5.1", "Except when the Carrier has extended credit to the consignee without the written consent of the shipper, the shipper guarantees payment of all charges for the carriage due in accordance with Carrier's tariff, conditions of carriage and related regulations, applicable laws (including national laws implementing the Warsaw Convention and the Montreal Convention), government regulations, orders and requirements."],
  ["5.2", "When no part of the consignment is delivered, a claim with respect to such consignment will be considered even though transportation charges thereon are unpaid."],
];

const CONDITIONS_RIGHT = [
  ["6.1", "For cargo accepted for carriage, the Warsaw Convention and the Montreal Convention permit shipper to increase the limitation of liability by declaring a higher value for carriage and paying a supplemental charge if required."],
  ["6.2", "In carriage to which neither the Warsaw Convention nor the Montreal Convention applies Carrier shall, in accordance with the procedures set forth in its general conditions of carriage and applicable tariffs, permit shipper to increase the limitation of liability by declaring a higher value for carriage and paying a supplemental charge if so required."],
  ["7.1", "In cases of loss of, damage or delay to part of the cargo, the weight to be taken into account in determining Carrier's limit of liability shall be only the weight of the package or packages concerned."],
  ["7.2", "Notwithstanding any other provisions, for \"foreign air transportation\" as defined by the U.S. Transportation Code:"],
  ["7.2.1", "in the case of loss of, damage or delay to a shipment, the weight to be used in determining Carrier's limit of liability shall be the weight which is used to determine the charge for carriage of such shipment; and"],
  ["7.2.2", "in the case of loss of, damage or delay to a part of a shipment, the shipment weight in 7.2.1 shall be prorated to the packages covered by the same air waybill whose value is affected by the loss, damage or delay. The weight applicable in the case of loss or damage to one or more articles in a package shall be the weight of the entire package."],
  ["8.", "Any exclusion or limitation of liability applicable to Carrier shall apply to Carrier's agents, employees, and representatives and to any person whose aircraft or equipment is used by Carrier for carriage and such person's agents, employees and representatives."],
  ["9.", "Carrier undertakes to complete the carriage with reasonable dispatch. Where permitted by applicable laws, tariffs and government regulations, Carrier may use alternative carriers, aircraft or modes of transport without notice but with due regard to the interests of the shipper. Carrier is authorized by the shipper to select the routing and all intermediate stopping places that it deems appropriate or to change or deviate from the routing shown on the face hereof."],
  ["10.", "Receipt by the person entitled to delivery of the cargo without complaint shall be prima facie evidence that the cargo has been delivered in good condition and in accordance with the contract of carriage."],
  ["10.1", "In the case of loss of, damage or delay to cargo a written complaint must be made to Carrier by the person entitled to delivery. Such complaint must be made:"],
  ["10.1.1", "in the case of damage to the cargo, immediately after discovery of the damage and at the latest within 14 days from the date of receipt of the cargo;"],
  ["10.1.2", "in the case of delay, within 21 days from the date on which the cargo was placed at the disposal of the person entitled to delivery."],
  ["10.1.3", "in the case of non-delivery of the cargo, within 120 days from the date of issue of the air waybill, or if an air waybill has not been issued, within 120 days from the date of receipt of the cargo for transportation by the Carrier."],
  ["10.2", "Such complaint may be made to the Carrier whose air waybill was used, or to the first Carrier or to the last Carrier or to the Carrier, which performed the carriage during which the loss, damage or delay took place."],
  ["10.3", "Unless a written complaint is made within the time limits specified in 10.1 no action may be brought against Carrier."],
  ["10.4", "Any rights to damages against Carrier shall be extinguished unless an action is brought within two years from the date of arrival at the destination, or from the date on which the aircraft ought to have arrived, or from the date on which the carriage stopped."],
  ["11.", "Shipper shall comply with all applicable laws and government regulations of any country to or from which the cargo may be carried, including those relating to the packing, carriage or delivery of the cargo, and shall furnish such information and attach such documents to the air waybill as may be necessary to comply with such laws and regulations. Carrier is not liable to shipper and shipper shall indemnify Carrier for loss or expense due to shipper's failure to comply with this provision."],
  ["12.", "No agent, employee or representative of Carrier has authority to alter, modify or waive any provisions of this contract."],
];

function clauses(rows: string[][]): string {
  return rows.map(([n, t]) => `<div class="clause"><span class="n">${n}</span><span>${t}</span></div>`).join("");
}

function conditionsPage(): string {
  return `
<section class="page conditions">
  <h2>NOTICE CONCERNING CARRIERS' LIMITATION OF LIABILITY</h2>
  <p>If the carriage involves an ultimate destination or stop in a country other than the country of departure, the Warsaw Convention or the
  Montreal Convention may be applicable and in most cases limit the liability of the Carrier in respect of loss of, damage or delay to cargo.
  Depending on the applicable regime, and unless a higher value is declared, liability of the Carrier may be limited to 17 Special Drawing Rights
  per kilogram or 250 French gold francs per kilogram, converted into national currency under applicable law. Carrier will treat 250 French gold
  francs to be the conversion equivalent of 17 Special Drawing Rights unless a greater amount is specified in the Carrier's conditions of carriage.</p>
  <h2>CONDITIONS OF CONTRACT</h2>
  <div class="cols"><div>${clauses(CONDITIONS_LEFT)}</div><div>${clauses(CONDITIONS_RIGHT)}</div></div>
</section>`;
}

export function hawb(data: HawbData): string {
  const pages = COPIES.map((copy) => facePage(data, copy) + conditionsPage()).join("");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>HAWB ${escapeHtml(data.hawbNumber)}</title>
<style>
  @page { size: Letter; margin: 0.3in 0.35in; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; font-size: 7pt; color: #000; }
  .page { break-after: page; }
  .page:last-child { break-after: auto; }
  .v { font-family: "Courier New", Courier, monospace; font-weight: bold; font-size: 8.5pt; text-transform: uppercase; line-height: 1.2; }
  .lbl { font-size: 6.5pt; display: block; }
  .c { text-align: center; }
  .r { text-align: right; }
  .small { font-size: 5.6pt; line-height: 1.25; }
  .tiny { font-size: 5pt; line-height: 1.2; font-weight: bold; }
  .mawb { font-family: "Courier New", Courier, monospace; font-weight: bold; font-size: 10.5pt; padding: 0 0 2px 22px; min-height: 16px; }
  table.grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.grid td { border: 0.8px solid #000; vertical-align: top; padding: 1px 3px; }
  table.grid + table.grid tr:first-child td { border-top: 0; }
  td.tall { height: 0.95in; }
  td.nopad { padding: 0; }
  .awb-head { display: flex; border-bottom: 0.8px solid #000; }
  .awb-head .nn { padding: 1px 3px; border-right: 0.8px solid #000; width: 30%; }
  .awb-head .nn b { font-size: 9pt; display: block; }
  .hawb-no { padding: 4px 6px; font-size: 10pt; }
  .issued { padding: 2px 6px 0 30%; min-height: 0.35in; }
  .copies { font-size: 5.6pt; border-top: 0.8px solid #000; padding: 1px 3px; }
  .pc { display: flex; justify-content: space-around; font-size: 6.5pt; }
  .handling { height: 0.45in; }
  .licence { display: flex; justify-content: space-between; align-items: baseline; font-size: 6.5pt; }
  table.cargo .head td { font-size: 6.3pt; text-align: center; vertical-align: middle; }
  table.cargo .body td { height: 2.55in; }
  table.cargo .totals td { height: 0.2in; }
  .m3 { margin-top: 2px; white-space: nowrap; }
  table.charges td { height: 0.24in; }
  .sigline { vertical-align: bottom !important; text-align: center; }
  .exec { display: flex; justify-content: space-between; gap: 6px; }
  table.charges td.foot-cell { height: 0.42in; }
  .foot { display: flex; justify-content: space-between; }
  .foot > div { text-align: center; font-size: 9.5pt; padding-right: 0.4in; }
  .conditions h2 { text-align: center; font-size: 9.5pt; margin: 8px 0 4px; }
  .conditions p { font-size: 6.6pt; line-height: 1.3; margin: 0 0 6px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .clause { display: flex; gap: 8px; font-size: 6.6pt; line-height: 1.3; margin-bottom: 4px; }
  .clause .n { flex: 0 0 34px; }
</style>
</head>
<body>${pages}</body>
</html>`;
}
