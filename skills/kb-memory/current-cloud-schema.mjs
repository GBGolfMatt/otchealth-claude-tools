/** One reviewed source of truth for the bounded current-cloud entity seed. */
export const normEntityKey = (value) => String(value || "").toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export const CURRENT_CLOUD_ENTITIES = Object.freeze([
  { key: "otchealth_primary_cloud", value: "AWS is the active company cloud estate.", source: "Live AWS metadata verification, 2026-09-07" },
  { key: "otchealth_gateway_runtime", value: "AWS ECS on Fargate in us-east-1 at mcp.otchealth.app.", source: "Live ECS task definition 53 verification, 2026-09-07" },
  { key: "otchealth_brain_backend", value: "Amazon OpenSearch Service domain otchealth-brain on AWS, federated by brain_search.", source: "Live OpenSearch and gateway verification, 2026-09-07" },
  { key: "otchealth_agent_state_backend", value: "Amazon RDS for PostgreSQL database otchealth-pg on AWS.", source: "Live RDS and gateway task definition 53 verification, 2026-09-07" },
]);

export const CURRENT_CLOUD_ALIASES = Object.freeze([
  { phrase: "what cloud platform is the company brain running on now and is azure still active", target: "otchealth_brain_backend", source: "bounded-fast-eval current-cloud, 2026-09-07" },
  { phrase: "what is the current search backend and live index architecture for brain_search", target: "otchealth_brain_backend", source: "bounded-fast-eval current-backend, 2026-09-07" },
  { phrase: "what is otchealth's current primary cloud", target: "otchealth_primary_cloud", source: "current cloud natural-query alias, 2026-09-07" },
  { phrase: "where is the otchealth gateway running now", target: "otchealth_gateway_runtime", source: "current gateway natural-query alias, 2026-09-07" },
  { phrase: "what is the current otchealth agent state backend", target: "otchealth_agent_state_backend", source: "current state natural-query alias, 2026-09-07" },
]);

export const APPROVED_ENTITY_KEYS = Object.freeze(CURRENT_CLOUD_ENTITIES.map((item) => item.key));
export const APPROVED_ALIAS_KEYS = Object.freeze(CURRENT_CLOUD_ALIASES.map((item) => normEntityKey(item.phrase)));
