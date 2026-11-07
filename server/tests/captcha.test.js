const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCaptchaStore,
  angleError,
  TTL_MS,
  MAX_ENTRIES,
  TOLERANCE_DEG,
  MAX_ISSUE_PER_IP,
} = require("../lib/captcha");

// 假出图：图被转了 angle 度，正确答案是再转 360 - angle 度。
function fakeStore(angles) {
  let t = 1_000_000;
  const queue = [...angles];
  const store = createCaptchaStore(
    () => t,
    async () => ({ angle: queue.length ? queue.shift() : 90, png: Buffer.from("png") })
  );
  return { store, advance: (ms) => { t += ms; } };
}

test("angleError: wraps around 360 and is symmetric", () => {
  assert.equal(angleError(90, 270), 0);
  assert.equal(angleError(90, 265), 5);
  assert.equal(angleError(90, 275), 5);
  assert.equal(angleError(350, 0), 10);
  assert.equal(angleError(10, 360), 10);
  assert.equal(angleError(180, 0), 180);
});

test("captcha: rotating the hand upright passes exactly once", async () => {
  const { store } = fakeStore([100]);
  const { id } = await store.issue();
  assert.equal(store.consume(id, 260), true);
  assert.equal(store.consume(id, 260), false);
});

test("captcha: tolerance edge is inclusive, one degree past fails", async () => {
  const { store } = fakeStore([100, 100]);
  const a = await store.issue();
  assert.equal(store.consume(a.id, 260 + TOLERANCE_DEG), true);
  const b = await store.issue();
  assert.equal(store.consume(b.id, 260 + TOLERANCE_DEG + 1), false);
});

test("captcha: a wrong angle burns the challenge", async () => {
  const { store } = fakeStore([100]);
  const { id } = await store.issue();
  assert.equal(store.consume(id, 0), false);
  assert.equal(store.consume(id, 260), false);
});

test("captcha: non-numeric or out-of-range answers fail", async () => {
  const { store } = fakeStore([100, 100, 100]);
  assert.equal(store.consume((await store.issue()).id, "abc"), false);
  assert.equal(store.consume((await store.issue()).id, -100), false);
  assert.equal(store.consume((await store.issue()).id, 620), false);
});

test("captcha: numeric strings from JSON are accepted", async () => {
  const { store } = fakeStore([100]);
  const { id } = await store.issue();
  assert.equal(store.consume(id, "258.5"), true);
});

test("captcha: expires after TTL", async () => {
  const { store, advance } = fakeStore([100]);
  const { id } = await store.issue();
  advance(TTL_MS);
  assert.equal(store.consume(id, 260), false);
});

test("captcha: unknown or missing id fails", () => {
  const { store } = fakeStore([]);
  assert.equal(store.consume("deadbeef", 270), false);
  assert.equal(store.consume(undefined, undefined), false);
});

test("captcha: map is capped and evicts the oldest", async () => {
  const { store } = fakeStore([]);
  const first = (await store.issue()).id;
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) await store.issue();
  assert.ok(store.size() <= MAX_ENTRIES);
  assert.equal(store.consume(first, 270), false);
});

test("captcha: image issuing is rate limited per IP and resets after a minute", () => {
  const { store, advance } = fakeStore([]);
  for (let i = 0; i < MAX_ISSUE_PER_IP; i += 1) assert.equal(store.allowIssue("1.1.1.1"), true);
  assert.equal(store.allowIssue("1.1.1.1"), false);
  assert.equal(store.allowIssue("2.2.2.2"), true);
  advance(60 * 1000);
  assert.equal(store.allowIssue("1.1.1.1"), true);
});

test("captcha: real generator returns a PNG that does not carry the angle", async () => {
  const store = createCaptchaStore();
  const { id, image } = await store.issue();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.ok(image.startsWith("data:image/png;base64,"));
  const png = Buffer.from(image.slice("data:image/png;base64,".length), "base64");
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]); // "PNG"
  assert.doesNotMatch(png.toString("latin1"), /rotate|<svg/i);
});
