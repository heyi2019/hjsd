import { useCallback, useMemo } from "react";
import { gameTypesApi } from "../api/misc.api";
import { useSettingsResource } from "../state/useSettingsResource";
import { useReferenceRefresh } from "./useReferenceRefresh";
import { useOptionSet } from "../lib/optionSets";

const loadGameTypes = async () => {
  const items = await gameTypesApi.list({ include_inactive: true });
  return Array.isArray(items) ? items : [];
};

/** 游戏和渠道编码用于存储；业务页面通过此处统一显示名称。 */
export function useGameReferences() {
  const { data, loading, error, reload } = useSettingsResource(loadGameTypes);
  const archive = useOptionSet("GAME_REFERENCE_ARCHIVE");
  useReferenceRefresh("gameTypes", reload);
  const { games, channels } = useMemo(() => {
    const games = new Map<string, string>();
    const channels = new Map<string, string>();
    for (const item of archive ?? []) {
      (item.value.startsWith("game_") ? games : channels).set(item.value, item.label);
    }
    for (const item of data ?? []) {
      games.set(item.value, item.name);
      for (const region of item.channel_regions ?? []) channels.set(region.value, region.label);
    }
    return { games, channels };
  }, [data, archive]);
  const gameLabel = useCallback((value: string) => games.get(value) ?? value, [games]);
  const channelLabel = useCallback((value: string) => channels.get(value) ?? value, [channels]);
  return { data: data ?? [], loading, error, reload, gameLabel, channelLabel };
}
