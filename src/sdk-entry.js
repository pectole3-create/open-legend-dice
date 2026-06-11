// Entry point for bundling the Owlbear Rodeo SDK into a single self-contained
// ESM file (public/owlbear-sdk.js) so the extension never depends on a
// third-party CDN at runtime. Rebuild with: npm run build:sdk
export { default } from "@owlbear-rodeo/sdk";
