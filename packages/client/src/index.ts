export type RenderPayload =
  | { kind: "capture"; capture: unknown }
  | { kind: "html"; html: string; viewport?: { width: number; height: number } }
  | { kind: "url"; url: string };

export type CreateRenderRequest = {
  channel: string;
  name?: string;
  payload: RenderPayload;
};

export type CreateRenderResponse = {
  renderId: string;
  status: "queued" | "translating";
  statusUrl: string;
};

export type RenderStatus =
  | "queued"
  | "translating"
  | "delivering"
  | "delivered"
  | "done"
  | "failed";

export type RenderWarning = { code: string; nodeId?: string; detail?: string };
export type RenderSummary = {
  layers?: number;
  rasterRegions?: number;
  fontsSubstituted?: number;
};

export type RenderProgress = {
  pct?: number;
  count?: number;
  total?: number;
  stage?: "fetching" | "building";
  at: string;
};

export type GetRenderResponse = {
  renderId: string;
  status: RenderStatus;
  warnings: RenderWarning[];
  error: { code: string; message: string } | null;
  summary: RenderSummary | null;
  progress: RenderProgress | null;
  timing: Record<string, number>;
  createdAt: string;
  doneAt: string | null;
};

export type ContextScope = "selection" | "page";
export type ContextResponse = { context: { nodes: unknown[] } & Record<string, unknown> };

export class DesignBridgeClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async createRender(body: CreateRenderRequest): Promise<CreateRenderResponse> {
    return this.request<CreateRenderResponse>("/v1/renders", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getRender(renderId: string): Promise<GetRenderResponse> {
    return this.request<GetRenderResponse>(`/v1/renders/${encodeURIComponent(renderId)}`, {
      method: "GET",
    });
  }

  /** Round-trip the live Figma canvas (selection/page) through the relay to the paired plugin. */
  async requestContext(scope: ContextScope, channel = "default"): Promise<ContextResponse> {
    return this.request<ContextResponse>("/v1/context", {
      method: "POST",
      body: JSON.stringify({ channel, scope }),
    });
  }

  async pair(code: string) {
    return this.request("/v1/pair", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const res = await fetchImpl(new URL(path, this.options.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
        ...init.headers,
      },
    });
    const json = (await res.json()) as T;
    if (!res.ok) {
      throw Object.assign(new Error(`DesignBridge request failed: ${res.status}`), {
        status: res.status,
        body: json,
      });
    }
    return json;
  }
}
