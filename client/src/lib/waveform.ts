/**
 * 음성 메시지 파형(피크) 유틸.
 *
 * 송신자가 녹음 직후 한 번만 계산해 암호문 페이로드에 담고, 수신자는 그 값을 그대로 그린다.
 * (수신 측에서 매번 디코딩하면 5분 음성 기준 수십 MB 의 PCM 을 잠시 점유하게 된다.)
 */
export const WAVEFORM_BARS = 48;

/** Float32 PCM(모노)에서 0~100 높이의 막대 배열을 만든다. */
export function peaksFromChannelData(
  data: Float32Array,
  bars: number = WAVEFORM_BARS,
): number[] {
  const count = Math.max(1, Math.floor(bars));
  if (data.length === 0) return new Array<number>(count).fill(3);

  const blockSize = Math.max(1, Math.floor(data.length / count));
  const peaks: number[] = [];
  for (let bar = 0; bar < count; bar += 1) {
    const start = bar * blockSize;
    const end = Math.min(data.length, start + blockSize);
    let max = 0;
    for (let index = start; index < end; index += 1) {
      const value = Math.abs(data[index] ?? 0);
      if (value > max) max = value;
    }
    // 침묵 구간도 보이도록 최소 3%.
    peaks.push(Math.max(3, Math.min(100, Math.round(max * 100))));
  }
  return peaks;
}

/**
 * 오디오 바이트를 낮은 샘플레이트로 디코딩해 피크를 계산한다.
 * 브라우저가 디코딩하지 못하면 null(파형 없이 재생만 제공).
 */
export async function computeWaveform(
  bytes: ArrayBuffer,
  bars: number = WAVEFORM_BARS,
): Promise<number[] | null> {
  if (typeof AudioContext === "undefined") return null;
  let context: AudioContext | null = null;
  try {
    // 8kHz 로 디코딩해 메모리를 줄인다(5분 모노 기준 약 5MB).
    context = new AudioContext({ sampleRate: 8_000 });
    const buffer = await context.decodeAudioData(bytes.slice(0));
    return peaksFromChannelData(buffer.getChannelData(0), bars);
  } catch {
    return null;
  } finally {
    void context?.close();
  }
}
