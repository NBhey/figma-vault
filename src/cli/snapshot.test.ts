import assert from "node:assert/strict";
import { test } from "node:test";

import { snapshotScript } from "./snapshot.js";

test("скрипт снимка разбирается как JavaScript и не ломается на кавычках в id", () => {
  for (const id of ["1:1", "I10812:94971;8155:91668", `4:2"); alert("x`]) {
    const script = snapshotScript(id);
    assert.doesNotThrow(() => new Function(script), `скрипт для ${id} не разбирается`);
    assert.ok(script.includes(JSON.stringify(id)), "id вставлен как JSON-строка, а не сырым текстом");
  }
});
