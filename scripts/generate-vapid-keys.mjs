import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
if (!jwk.x || !jwk.y || !jwk.d) {
  throw new Error("Failed to export P-256 key");
}

const x = Buffer.from(jwk.x, "base64url");
const y = Buffer.from(jwk.y, "base64url");
const d = Buffer.from(jwk.d, "base64url");
const publicKey = Buffer.concat([Buffer.from([0x04]), x, y]).toString("base64url");

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${d.toString("base64url")}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");
