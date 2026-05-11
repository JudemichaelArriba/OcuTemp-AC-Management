export interface DecisionLog {
  readonly id: string;
  readonly aiAutoApply: boolean;
  readonly applied: boolean;
  readonly deviceId: string;
  readonly eventType: string;
  readonly mode: string;
  readonly power: boolean;
  readonly reason: string;
  readonly roomUid: string;
  readonly source: string;
  readonly targetTemp: number;
  readonly updatedAt: string;       
  readonly uptimeMs: number;
  readonly irSent?: boolean;
  readonly previousPower?: boolean;
  readonly previousSource?: string;
  readonly previousTemp?: number;
  readonly suggestedTemp?: number;
}