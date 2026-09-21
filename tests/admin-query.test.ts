import assert from "node:assert/strict";
import test from "node:test";
import { accountSearchFromQuery } from "../web/src/admin-query.ts";

test("cloud overview q 参数完整解码 iCloud 加号别名", () => {
  assert.equal(
    accountSearchFromQuery("?q=steamer.rover-4r%2Boaiv0i%40icloud.com"),
    "steamer.rover-4r+oaiv0i@icloud.com",
  );
});

test("旧 search 参数继续可用且 q 优先", () => {
  assert.equal(accountSearchFromQuery("?search=legacy%40example.com"), "legacy@example.com");
  assert.equal(accountSearchFromQuery("?q=new%40example.com&search=legacy%40example.com"), "new@example.com");
});
