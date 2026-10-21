export function durationOf(pcm) {
    return pcm.samples.length / pcm.channels / pcm.sampleRate;
}
/** 最大音量(dBFS)。完全な無音なら -Infinity */
export function peakDbfs(pcm) {
    let peak = 0;
    for (const sample of pcm.samples)
        peak = Math.max(peak, Math.abs(sample));
    return peak === 0 ? -Infinity : 20 * Math.log10(peak / 32768);
}
export function silence(seconds, sampleRate, channels = 1) {
    const frames = Math.max(0, Math.round(seconds * sampleRate));
    return { sampleRate, channels, samples: new Int16Array(frames * channels) };
}
/** RIFF/WAVE(16bit PCM)を読む。fmt と data 以外のチャンクは読み飛ばす。 */
export function parseWav(buffer) {
    if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error("WAV 形式ではありません");
    }
    let offset = 12;
    let format;
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString("ascii", offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const body = offset + 8;
        if (id === "fmt ") {
            format = {
                audioFormat: buffer.readUInt16LE(body),
                channels: buffer.readUInt16LE(body + 2),
                sampleRate: buffer.readUInt32LE(body + 4),
                bits: buffer.readUInt16LE(body + 14),
            };
        }
        else if (id === "data") {
            if (!format)
                throw new Error("WAV の fmt チャンクが data より後にあります");
            if (format.audioFormat !== 1 || format.bits !== 16) {
                throw new Error(`未対応の WAV 形式です(format=${format.audioFormat}, bits=${format.bits})`);
            }
            const length = Math.min(size, buffer.length - body) & ~1;
            const samples = new Int16Array(length / 2);
            for (let i = 0; i < samples.length; i++)
                samples[i] = buffer.readInt16LE(body + i * 2);
            return { sampleRate: format.sampleRate, channels: format.channels, samples };
        }
        offset = body + size + (size % 2);
    }
    throw new Error("WAV に data チャンクがありません");
}
export function encodeWav(pcm) {
    const dataSize = pcm.samples.length * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write("RIFF", 0, "ascii");
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8, "ascii");
    buffer.write("fmt ", 12, "ascii");
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(pcm.channels, 22);
    buffer.writeUInt32LE(pcm.sampleRate, 24);
    buffer.writeUInt32LE(pcm.sampleRate * pcm.channels * 2, 28);
    buffer.writeUInt16LE(pcm.channels * 2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36, "ascii");
    buffer.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < pcm.samples.length; i++)
        buffer.writeInt16LE(pcm.samples[i], 44 + i * 2);
    return buffer;
}
/** target の atSeconds の位置に source を加算合成する(はみ出した分は捨てる)。 */
export function mixInto(target, source, atSeconds) {
    if (source.sampleRate !== target.sampleRate || source.channels !== target.channels) {
        throw new Error(`音声の形式が一致しません(${source.sampleRate}Hz/${source.channels}ch と ${target.sampleRate}Hz/${target.channels}ch)`);
    }
    const start = Math.round(atSeconds * target.sampleRate) * target.channels;
    const end = Math.min(target.samples.length, start + source.samples.length);
    for (let i = Math.max(0, start); i < end; i++) {
        const value = target.samples[i] + source.samples[i - start];
        target.samples[i] = Math.max(-32768, Math.min(32767, value));
    }
}
