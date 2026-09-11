import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PubSub } from "../services/pubsub";
import { QueueService } from "../services/queue";

// Run against a disposable Redis instance, never an application's Redis.
const url = process.env.PARCAE_TEST_REDIS_URL;

describe.skipIf(!url)("shared Redis application namespaces", () => {
  const prefix = `parcae-test-${randomUUID()}`;
  const islandName = `${prefix}-island`;
  const episodesName = `${prefix}-episodes`;
  let redis: Redis;
  let island: PubSub;
  let replica: PubSub;
  let episodes: PubSub;
  const queues: QueueService[] = [];

  beforeAll(async () => {
    redis = new Redis(url!);
    island = new PubSub({ url, name: islandName });
    replica = new PubSub({ url, name: islandName });
    episodes = new PubSub({ url, name: episodesName });
    await Promise.all([redis.ping(), island.building, replica.building, episodes.building]);
  });

  afterAll(async () => {
    await Promise.all([
      ...[island, replica, episodes].map((service) => service.close()),
      ...queues.map((queue) => queue.close()),
    ]);
    await redis.quit();
  });

  it("delivers events to same-app replicas without leaking to another app", async () => {
    const received = { island: [] as string[], replica: [] as string[], episodes: [] as string[] };
    const unsubscribe = [
      island.on("message", (value: string) => received.island.push(value)),
      replica.on("message", (value: string) => received.replica.push(value)),
      episodes.on("message", (value: string) => received.episodes.push(value)),
    ];
    try {
      island.emit("message", "from island");
      episodes.emit("message", "from episodes");
      await expect.poll(() => received).toEqual({
        island: ["from island"],
        replica: ["from island"],
        episodes: ["from episodes"],
      });
      expect(await redis.pubsub("CHANNELS", `${prefix}*`)).toEqual(
        expect.arrayContaining([`${islandName}:events`, `${episodesName}:events`]),
      );
    } finally {
      unsubscribe.forEach((off) => off());
    }
  });

  it("shares locks with replicas while another app can hold the same resource", async () => {
    const unlockIsland = await island.lock("resource:shared", 5000);
    const unlockEpisodes = await episodes.lock("resource:shared", 5000);
    try {
      expect(await replica.tryLock("resource:shared", 5000)).toBe(false);
      expect(await redis.exists(`${islandName}:resource:shared`, `${episodesName}:resource:shared`)).toBe(2);
      await unlockIsland();
      expect(await redis.exists(`${islandName}:resource:shared`)).toBe(0);
      expect(await redis.exists(`${episodesName}:resource:shared`)).toBe(1);
      expect(await replica.tryLock("resource:shared", 5000)).toBe(true);
    } finally {
      await unlockEpisodes();
    }
  });

  it("deduplicates a cron tick within each app independently", async () => {
    const key = "cron:tick:cleanup:1700000000000";
    const results = await Promise.all([
      island.tryLock(key, 5000),
      replica.tryLock(key, 5000),
      episodes.tryLock(key, 5000),
    ]);
    expect(results.slice(0, 2).filter(Boolean)).toHaveLength(1);
    expect(results[2]).toBe(true);
    expect(await redis.ttl(`${islandName}:${key}`)).toBeGreaterThan(0);
    expect(await redis.ttl(`${episodesName}:${key}`)).toBeGreaterThan(0);
  });

  it("routes identical job names and IDs to each app's own worker", async () => {
    const processed: string[] = [];
    for (const name of [islandName, episodesName]) {
      const service = new QueueService({ url, name });
      queues.push(service);
      await service.building;
      const queueName = service.queueNameFor("render");
      const worker = service.createWorker(queueName, async (job) => {
        processed.push(`${name}:${job.data.app}`);
      })!;
      await worker.waitUntilReady();
      await service.get(queueName)!.add("render", { app: name }, { jobId: "shared" });
    }
    await expect.poll(() => [...processed].sort()).toEqual(
      [`${islandName}:${islandName}`, `${episodesName}:${episodesName}`].sort(),
    );
  });
});
