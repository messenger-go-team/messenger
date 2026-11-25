const assert = require("node:assert/strict");

// Compare values across Bruno JS realms, and identify participants by ID.
function assertReceiptSnapshot(body, fixture, expected, headers) {
  assert.equal(headers["cache-control"], "no-store", "receipts no-store");
  assert.equal(body.chat_id, fixture.chatAB, "receipts chat_id");
  assert.equal(body.members.length, 2, "receipts two participants");
  const ids = body.members.map((m) => m.user_id);
  assert.equal(new Set(ids).size, 2, "receipts unique participants");
  assert.deepEqual(
    [...ids].sort(),
    [fixture.aID, fixture.bID].sort(),
    "receipts participant IDs",
  );
  const byID = new Map(body.members.map((m) => [m.user_id, m]));
  for (const [index, userID] of [fixture.aID, fixture.bID].entries()) {
    const member = byID.get(userID);
    const [delivered, read] = expected[index];
    assert.ok(
      Number.isSafeInteger(member.last_delivered_seq),
      "receipts safe delivered",
    );
    assert.ok(Number.isSafeInteger(member.last_read_seq), "receipts safe read");
    assert.ok(
      0 <= member.last_read_seq &&
        member.last_read_seq <= member.last_delivered_seq &&
        member.last_delivered_seq <= 205,
      "receipts cursor bounds",
    );
    assert.equal(
      member.last_delivered_seq,
      delivered,
      "receipts expected delivered",
    );
    assert.equal(member.last_read_seq, read, "receipts expected read");
  }
}

module.exports = { assertReceiptSnapshot };
