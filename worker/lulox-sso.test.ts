import assert from "node:assert/strict";
import { test } from "node:test";
import { readSso, signSso } from "./lulox-sso";

const SECRET = "s".repeat(48);
const req = (cookie: string) => new Request("https://tarask.lulox.com.ar/api/me", { headers: { cookie } });

test("lulox_sso: valid cookie verifies, forged or expired does not", async () => {
  const v = await signSso({ email: "a@b.com", name: "A", picture: "" }, SECRET, 60_000);
  assert.equal((await readSso(req(`lulox_sso=${v}`), SECRET))?.email, "a@b.com");
  assert.equal(await readSso(req(`lulox_sso=${v}`), "t".repeat(48)), null);
  assert.equal(await readSso(req(`lulox_sso=${v.slice(0, -2)}xx`), SECRET), null);
  const old = await signSso({ email: "a@b.com", name: "A", picture: "" }, SECRET, 1, Date.now() - 10_000);
  assert.equal(await readSso(req(`lulox_sso=${old}`), SECRET), null);
  assert.equal(await readSso(req(`lulox_sso=${v}`), undefined), null);
});
