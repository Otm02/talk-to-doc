import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSemaphore } from "./concurrency";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const far = () => Date.now() + 60_000;

describe("createSemaphore", () => {
  it("lets up to max callers in at once", async () => {
    const sem = createSemaphore(2);
    await sem.acquire(far());
    await sem.acquire(far());
    expect(sem.active).toBe(2);
    expect(sem.waiting).toBe(0);
  });

  it("makes the third caller wait until a slot is released", async () => {
    const sem = createSemaphore(2);
    const releaseA = await sem.acquire(far());
    await sem.acquire(far());

    let thirdIn = false;
    const third = sem.acquire(far()).then((release) => {
      thirdIn = true;
      return release;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(thirdIn).toBe(false);
    expect(sem.waiting).toBe(1);
    expect(sem.active).toBe(2);

    releaseA();
    await third;
    expect(thirdIn).toBe(true);
    expect(sem.active).toBe(2);
    expect(sem.waiting).toBe(0);
  });

  it("serves waiters in arrival order", async () => {
    const sem = createSemaphore(1);
    const release = await sem.acquire(far());
    const order: string[] = [];
    const a = sem.acquire(far()).then((r) => (order.push("a"), r));
    const b = sem.acquire(far()).then((r) => (order.push("b"), r));
    release();
    (await a)();
    (await b)();
    expect(order).toEqual(["a", "b"]);
  });

  it("ignores a second release of the same slot", async () => {
    const sem = createSemaphore(1);
    const release = await sem.acquire(far());
    release();
    release();
    expect(sem.active).toBe(0);
    await sem.acquire(far());
    // A double release must not have created a phantom second slot.
    let secondIn = false;
    void sem.acquire(far()).then(() => (secondIn = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(secondIn).toBe(false);
  });

  it("rejects with pdf_timeout when the deadline passes while waiting", async () => {
    const sem = createSemaphore(1);
    await sem.acquire(far());
    const waiting = sem.acquire(Date.now() + 5000);
    const assertion = expect(waiting).rejects.toMatchObject({
      code: "pdf_timeout",
      httpStatus: 504,
    });
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    expect(sem.waiting).toBe(0);
    expect(sem.active).toBe(1);
  });

  it("does not hand a slot to a waiter that already timed out", async () => {
    const sem = createSemaphore(1);
    const release = await sem.acquire(far());
    const gone = sem.acquire(Date.now() + 100);
    const assertion = expect(gone).rejects.toMatchObject({
      code: "pdf_timeout",
    });
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    release();
    expect(sem.active).toBe(0);
  });

  it("rejects at once when the deadline has already passed and no slot is free", async () => {
    const sem = createSemaphore(1);
    await sem.acquire(far());
    const late = sem.acquire(Date.now() - 1);
    const assertion = expect(late).rejects.toMatchObject({
      code: "pdf_timeout",
    });
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});
