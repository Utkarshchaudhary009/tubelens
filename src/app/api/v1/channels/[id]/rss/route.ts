import type { NextRequest, NextResponse } from "next/server";
import { type ChannelRssDeps, handleChannelRss } from "@/lib/utils";
import { defaultResolveChannelId, firstTabFromChannel } from "../../_lib";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export type ChannelRssRouteDeps = ChannelRssDeps;

const defaultDeps: ChannelRssRouteDeps = {
  resolveChannelId: defaultResolveChannelId,
  // ONE getChannel per cold miss: the title and the uploads tab both derive
  // from this single payload (never a second getChannel for the tab).
  fetchChannel: async (channelId: string) => {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    return withTimeout(async () => {
      const innertube = await getInnertube();
      const channel = (await innertube.getChannel(channelId)) as Parameters<
        typeof firstTabFromChannel
      >[0];
      return {
        profile: channel,
        firstPage: await firstTabFromChannel(channel, "videos"),
      };
    }, 8000);
  },
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleChannelRss(req, id, defaultDeps);
}
