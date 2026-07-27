import { invalidateRegistryCache } from "./registry.js";
import { runModelIntelligenceRefresh } from "./modelIntelligenceRefresh.js";
import { mergeModelRefreshConfig } from "./modelSnapshotStore.js";

let lastScheduledRunDay = null;

export function startModelRefreshScheduler(getConfig) {
  const tick = async () => {
    try {
      const config = await getConfig();
      const refresh = mergeModelRefreshConfig(config.routing?.smartRoute ?? {});
      if (!refresh.enabled) {
        return;
      }
      if (!isScheduledMinute(refresh.schedule, refresh.timezone)) {
        return;
      }
      const dayKey = todayKey(refresh.timezone);
      if (lastScheduledRunDay === dayKey) {
        return;
      }
      lastScheduledRunDay = dayKey;
      console.log("Model intelligence refresh: scheduled run starting");
      const result = await runModelIntelligenceRefresh(config, { probe: true });
      invalidateRegistryCache();
      if (result.ok) {
        console.log(
          `Model intelligence refresh: ok (${result.snapshot?.models?.length ?? 0} models)`
        );
      } else {
        console.warn(`Model intelligence refresh failed: ${result.error}`);
      }
    } catch (error) {
      console.warn(`Model refresh scheduler: ${error.message}`);
    }
  };

  setInterval(tick, 60_000);
  tick().catch(() => {});
}

function parseCronHourMinute(schedule) {
  const parts = String(schedule ?? "0 3 * * *").trim().split(/\s+/);
  if (parts.length < 2) {
    return { minute: 0, hour: 3 };
  }
  return { minute: Number(parts[0]) || 0, hour: Number(parts[1]) || 3 };
}

export function isScheduledMinute(schedule, timezone) {
  const { minute, hour } = parseCronHourMinute(schedule);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    hour: "numeric",
    minute: "numeric",
    hour12: false
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  return h === hour && m === minute;
}

function todayKey(timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
