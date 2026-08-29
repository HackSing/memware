import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { MemwareEnv } from "../../src/memware/env";
import { MemoryRegistry } from "../../src/memware/memoryRegistry";
import { createMemwareServer } from "../../src/memware/server";
import { initializeTrustedTenantContext, type TenantContext } from "../../src/memware/tenant";
import { TenantMemoryHandle } from "../../src/memware/tenantMemoryHandle";
import {
  TenantAuthorizationError,
  TenantCapacityError,
  TrustedMultiTenantProvider,
  type RequestSecurityContext,
} from "../../src/memware/tenantProvider";
import { buildStubMemory, type StubState } from "./stubMemory";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function securityContext(tenantId: string, issuer = "avatanel.test"): RequestSecurityContext {
  return {
    issuer,
    principalId: `principal:${tenantId}`,
    tenantId,
    requestId: `request:${tenantId}`,
    authMethod: "test-session",
    scopes: ["memory:read", "memory:write", "memory:reset"],
  };
}

function makeProvider(
  dataDir: string,
  options: { maxActiveTenants?: number; authorize?: (action: string) => boolean } = {},
): {
  provider: TrustedMultiTenantProvider;
  states: Map<string, StubState>;
  closed: string[];
} {
  const states = new Map<string, StubState>();
  const closed: string[] = [];
  const provider = new TrustedMultiTenantProvider({
    dataDir,
    maxActiveTenants: options.maxActiveTenants,
    authorize: async (_context, action) => options.authorize?.(action) ?? true,
    createHandle: async (tenant: TenantContext) => {
      const { service, state } = buildStubMemory();
      states.set(tenant.key, state);
      const handle = new TenantMemoryHandle(tenant, new MemoryRegistry(async () => service));
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closed.push(tenant.key);
        await close();
      };
      return handle;
    },
  });
  return { provider, states, closed };
}

test("trusted host requires authenticated context and authorizes before storage creation", async () => {
  const root = tempRoot("memware-provider-auth-");
  try {
    const { provider } = makeProvider(root, { authorize: () => false });
    await expect(provider.acquire({ action: "read" })).rejects.toBeInstanceOf(TenantAuthorizationError);
    await expect(provider.acquire({
      action: "read",
      securityContext: securityContext("alice"),
    })).rejects.toThrow("tenant_action_not_authorized");
    expect(existsSync(join(root, "tenants"))).toBe(false);
    await provider.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("caller userId is an assertion and cannot select a foreign tenant", async () => {
  const root = tempRoot("memware-provider-assertion-");
  try {
    const { provider, states } = makeProvider(root);
    await expect(provider.acquire({
      action: "read",
      requestedUserId: "bob",
      securityContext: securityContext("alice"),
    })).rejects.toThrow("tenant_assertion_mismatch");
    expect(states.size).toBe(0);

    const lease = await provider.acquire({
      action: "warmup",
      requestedUserId: "alice",
      securityContext: securityContext("alice"),
    });
    expect(lease.userId).toStartWith("t1_");
    expect(lease.userId).not.toContain("alice");
    expect(lease.handle.tenant.tenantRoot).not.toContain("alice");
    await lease.handle.run((memory) => memory.warmup(lease.userId));
    expect(states.get(lease.tenantRef)?.warmupCalls).toEqual([lease.userId]);
    await lease.release();
    await provider.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mutable host context cannot change tenant after authorization begins", async () => {
  const root = tempRoot("memware-provider-context-race-");
  try {
    let authorizeStarted!: () => void;
    const started = new Promise<void>((resolve) => { authorizeStarted = resolve; });
    let authorizeContinue!: () => void;
    const proceed = new Promise<void>((resolve) => { authorizeContinue = resolve; });
    const provider = new TrustedMultiTenantProvider({
      dataDir: root,
      authorize: async () => {
        authorizeStarted();
        await proceed;
        return true;
      },
      createHandle: async (tenant) => {
        const { service } = buildStubMemory();
        return new TenantMemoryHandle(tenant, new MemoryRegistry(async () => service));
      },
    });
    const mutable = { ...securityContext("alice") } as {
      -readonly [K in keyof RequestSecurityContext]: RequestSecurityContext[K]
    };
    const acquisition = provider.acquire({
      action: "read",
      requestedUserId: "alice",
      securityContext: mutable,
    });
    await started;
    mutable.tenantId = "bob";
    authorizeContinue();
    const lease = await acquisition;
    const alice = initializeTrustedTenantContext(root, { issuer: "avatanel.test", tenantId: "alice" });
    const bob = initializeTrustedTenantContext(root, { issuer: "avatanel.test", tenantId: "bob" });
    expect(lease.tenantRef).toBe(alice.key);
    expect(lease.tenantRef).not.toBe(bob.key);
    await lease.release();
    await provider.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider close during authorization cannot create a late tenant handle", async () => {
  const root = tempRoot("memware-provider-close-race-");
  try {
    let authorizeStarted!: () => void;
    const started = new Promise<void>((resolve) => { authorizeStarted = resolve; });
    let authorizeContinue!: () => void;
    const proceed = new Promise<void>((resolve) => { authorizeContinue = resolve; });
    let factoryCalls = 0;
    const provider = new TrustedMultiTenantProvider({
      dataDir: root,
      authorize: async () => {
        authorizeStarted();
        await proceed;
        return true;
      },
      createHandle: async (tenant) => {
        factoryCalls += 1;
        const { service } = buildStubMemory();
        return new TenantMemoryHandle(tenant, new MemoryRegistry(async () => service));
      },
    });
    const acquisition = provider.acquire({
      action: "read",
      securityContext: securityContext("alice"),
    });
    await started;
    await provider.close();
    authorizeContinue();
    await expect(acquisition).rejects.toThrow("tenant_provider_closed");
    expect(factoryCalls).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issuer namespace separates same-named tenants and reset remains tenant-scoped", async () => {
  const root = tempRoot("memware-provider-isolation-");
  try {
    const { provider } = makeProvider(root);
    const a = await provider.acquire({
      action: "write",
      securityContext: securityContext("shared", "issuer-a"),
    });
    const b = await provider.acquire({
      action: "write",
      securityContext: securityContext("shared", "issuer-b"),
    });
    expect(a.tenantRef).not.toBe(b.tenantRef);
    expect(a.handle.tenant.tenantRoot).not.toBe(b.handle.tenant.tenantRoot);
    const aFile = join(a.handle.tenant.tenantRoot, "assets", "a.bin");
    const bFile = join(b.handle.tenant.tenantRoot, "assets", "b.bin");
    mkdirSync(join(a.handle.tenant.tenantRoot, "assets"), { recursive: true });
    mkdirSync(join(b.handle.tenant.tenantRoot, "assets"), { recursive: true });
    writeFileSync(aFile, "a");
    writeFileSync(bFile, "b");

    expect((await a.handle.reset()).ok).toBe(true);
    expect(existsSync(a.handle.tenant.tenantRoot)).toBe(false);
    expect(existsSync(bFile)).toBe(true);
    await a.release();
    await b.release();
    await provider.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("per-action authorization blocks reset before lifecycle side effects", async () => {
  const root = tempRoot("memware-provider-reset-auth-");
  try {
    const { provider } = makeProvider(root, { authorize: (action) => action !== "reset" });
    const write = await provider.acquire({
      action: "write",
      securityContext: securityContext("alice"),
    });
    const sentinel = join(write.handle.tenant.tenantRoot, "memory", "sentinel.bin");
    writeFileSync(sentinel, "private");
    await write.release();

    await expect(provider.acquire({
      action: "reset",
      securityContext: securityContext("alice"),
    })).rejects.toThrow("tenant_action_not_authorized");
    expect(existsSync(sentinel)).toBe(true);
    await provider.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tenant pool never evicts a leased tenant and reclaims idle capacity", async () => {
  const root = tempRoot("memware-provider-capacity-");
  try {
    const { provider, closed } = makeProvider(root, { maxActiveTenants: 1 });
    const a = await provider.acquire({ action: "read", securityContext: securityContext("a") });
    await expect(provider.acquire({
      action: "read",
      securityContext: securityContext("b"),
    })).rejects.toBeInstanceOf(TenantCapacityError);
    expect(closed).toEqual([]);
    const blockedTenant = initializeTrustedTenantContext(root, {
      issuer: "avatanel.test",
      tenantId: "b",
    });
    expect(existsSync(blockedTenant.tenantRoot)).toBe(false);

    await a.release();
    const b = await provider.acquire({ action: "read", securityContext: securityContext("b") });
    expect(closed).toEqual([a.tenantRef]);
    expect(provider.status()).toEqual({
      tenantBoundary: "trusted-host-v1",
      activeTenants: 1,
      maxActiveTenants: 1,
    });
    await b.release();
    await provider.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent checkout constructs one handle per tenant and respects capacity", async () => {
  const root = tempRoot("memware-provider-concurrency-");
  try {
    let factoryCalls = 0;
    const provider = new TrustedMultiTenantProvider({
      dataDir: root,
      maxActiveTenants: 1,
      authorize: async () => true,
      createHandle: async (tenant) => {
        factoryCalls += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        const { service } = buildStubMemory();
        return new TenantMemoryHandle(tenant, new MemoryRegistry(async () => service));
      },
    });
    const [a1, a2] = await Promise.all([
      provider.acquire({ action: "read", securityContext: securityContext("a") }),
      provider.acquire({ action: "write", securityContext: securityContext("a") }),
    ]);
    expect(factoryCalls).toBe(1);
    expect(a1.handle).toBe(a2.handle);

    const blocked = await Promise.allSettled([
      provider.acquire({ action: "read", securityContext: securityContext("b") }),
      provider.acquire({ action: "read", securityContext: securityContext("c") }),
    ]);
    expect(blocked.every((result) => result.status === "rejected")).toBe(true);
    await a1.release();
    await a2.release();
    await provider.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted MCP server resolves tenant only from authenticated transport context", async () => {
  const root = tempRoot("memware-provider-server-");
  const env: MemwareEnv = { apiKey: "test", dataDir: root, defaultUserId: "unused", debug: false };
  const { provider, states } = makeProvider(root);
  expect(() => createMemwareServer(env, provider)).toThrow("resolveSecurityContext");

  const server = createMemwareServer(env, provider, {
    resolveSecurityContext(extra) {
      const auth = extra.authInfo;
      const tenantId = auth?.extra?.tenantId;
      const issuer = auth?.extra?.issuer;
      if (!auth || typeof tenantId !== "string" || typeof issuer !== "string") {
        throw new TenantAuthorizationError("authenticated_tenant_required");
      }
      return {
        issuer,
        tenantId,
        principalId: auth.clientId,
        requestId: String(extra.requestId),
        authMethod: "mcp-access-token",
        scopes: auth.scopes,
      };
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let authInfo: AuthInfo = {
    token: "not-observed-by-resolver",
    clientId: "principal-a",
    scopes: ["memory:read", "memory:write"],
    extra: { issuer: "avatanel.test", tenantId: "alice" },
  };
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => send(message, { ...options, authInfo });
  await server.connect(serverTransport);
  const client = new Client({ name: "trusted-host-test", version: "0" });
  await client.connect(clientTransport);

  try {
    const first = await client.callTool({ name: "memory_warmup", arguments: { userId: "alice" } });
    expect(first.isError ?? false).toBe(false);
    const firstBody = JSON.parse((first.content[0] as { text: string }).text) as Record<string, string>;
    expect(firstBody.userId).toStartWith("t1_");
    expect(firstBody.userId).not.toContain("alice");

    const forged = await client.callTool({ name: "memory_warmup", arguments: { userId: "bob" } });
    expect(forged.isError).toBe(true);

    authInfo = {
      ...authInfo,
      clientId: "principal-b",
      extra: { issuer: "avatanel.test", tenantId: "bob" },
    };
    const second = await client.callTool({ name: "memory_warmup", arguments: {} });
    expect(second.isError ?? false).toBe(false);
    const secondBody = JSON.parse((second.content[0] as { text: string }).text) as Record<string, string>;
    expect(secondBody.userId).not.toBe(firstBody.userId);
    expect(states.size).toBe(2);
    expect([...states.values()].map((state) => state.warmupCalls.length).sort()).toEqual([1, 1]);
  } finally {
    await client.close();
    await server.close();
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});
