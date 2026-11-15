import { createContext, useContext } from "react";

/**
 * What the UI calls the agent: the daemon's `agentName` (config `agent.name`,
 * else IDENTITY.md's Name line), "Tomo" until it is known or on an older
 * daemon. The product itself — the tomo. mark, the page title, the favicon,
 * "restart Tomo" — keeps its own name.
 */
export const DEFAULT_AGENT_NAME = "Tomo";
export function agentNameOf(value: string | undefined | null): string {
  const name = value?.trim();
  return name ? name : DEFAULT_AGENT_NAME;
}
export const AgentNameContext = createContext(DEFAULT_AGENT_NAME);
export const useAgentName = () => useContext(AgentNameContext);
