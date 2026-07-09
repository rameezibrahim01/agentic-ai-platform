export const GATEWAY_READY = true;

export { FakeProvider, fakeIntent, fakeMessage } from "./provider.js";
export type {
  FakeBehavior,
  ModelProvider,
  ModelRequest,
  ProviderResult,
  Usage,
} from "./provider.js";

export { computeCostUsd, createGateway } from "./gateway.js";
export type {
  GatewayError,
  GatewayFailover,
  GatewayLogEntry,
  GatewayOptions,
  GatewayResult,
  ModelCalledPayload,
  ModelGateway,
  ModelPricing,
  PricingTable,
  ToolIntentPayload,
} from "./gateway.js";
