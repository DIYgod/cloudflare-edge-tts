import { errorResponse, json } from "../lib/http";
import { getVoices } from "../lib/tts";

export async function handleVoices() {
  try {
    const voices = await getVoices();
    return json({ voices });
  } catch (error) {
    console.error("voice list fetch failed", error);
    return errorResponse(502, "TTS_UPSTREAM_ERROR", "failed to fetch voices");
  }
}
