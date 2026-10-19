// Read SKY2C_FREIGHT_DESK_URL per request, not baked in at `next build` time — the Docker
// build doesn't have the runtime env, so a prerendered page would always show the default.
export const dynamic = "force-dynamic";

// Only rendered on this page: drops the root layout's <main> container width/padding and
// sizes the page to the viewport, so the embedded app fills everything under the nav bar.
const FULL_BLEED_CSS = `
  body:has(.freight-desk-frame) { height: 100dvh; overflow: hidden; }
  main:has(> .freight-desk-frame) { display: flex; max-width: none; min-height: 0; padding: 0; }
`;

/** Freight Desk Assistant (separate app) embedded full-screen under the TMS nav bar. */
export default function FreightDeskPage() {
  const src = process.env.SKY2C_FREIGHT_DESK_URL || "https://agent.demo.sky2c.com/";

  return (
    <>
      <style>{FULL_BLEED_CSS}</style>
      <iframe
        src={src}
        title="Freight Desk Assistant"
        className="freight-desk-frame"
        style={{ flex: 1, width: "100%", border: 0 }}
        allow="clipboard-write"
      />
    </>
  );
}
