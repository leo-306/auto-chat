import type { AppConfig, Job, JobEvent } from "@wechat-topic/shared";

export type ServerEvent = {
  type: string;
  jobId: string;
  job: Job | null;
  event?: JobEvent & { at?: string };
  at: string;
};

type Listener = (event: ServerEvent) => void;

export class EventHub {
  private listeners = new Set<Listener>();
  private configProvider: (() => AppConfig) | null = null;

  setConfigProvider(provider: () => AppConfig): void {
    this.configProvider = provider;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
    void this.sendWebhooks(event);
  }

  private async sendWebhooks(event: ServerEvent): Promise<void> {
    const urls = this.configProvider?.().webhookUrls ?? [];
    await Promise.allSettled(urls.map(url =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event)
      })
    ));
  }
}
