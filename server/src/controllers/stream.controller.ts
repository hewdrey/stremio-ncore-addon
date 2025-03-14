import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import mime from 'mime';
import { streamQuerySchema } from '@/schemas/stream.schema';
import type { TorrentService } from '@/services/torrent';
import type { StreamService } from '@/services/stream';
import type { UserService } from '@/services/user';
import type { TorrentStoreService } from '@/services/torrent-store';
import { playSchema } from '@/schemas/play.schema';
import { parseRangeHeader } from '@/utils/parse-range-header';
import { HttpStatusCode } from '@/types/http';
import type { TorrentSourceManager } from '@/services/torrent-source';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from 'ffprobe-installer';

import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { env } from '@/env';
import * as fs from 'node:fs';
import { Readable } from 'stream';
import WebTorrent from 'webtorrent';
import { spawn } from 'child_process';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

export class StreamController {
  constructor(
    private torrentSource: TorrentSourceManager,
    private torrentService: TorrentService,
    private streamService: StreamService,
    private userService: UserService,
    private torrentStoreService: TorrentStoreService,
  ) {}

  public async getStreamsForMedia(c: Context) {
    const params = c.req.param();
    const result = streamQuerySchema.safeParse(params);
    if (!result.success) {
      throw new HTTPException(HttpStatusCode.BAD_REQUEST, {
        message: result.error.message,
      });
    }
    const { imdbId, type, episode, season, deviceToken } = result.data;

    const user = await this.userService.getUserByDeviceTokenOrThrow(deviceToken);

    const torrents = await this.torrentSource.getTorrentsForImdbId({
      imdbId,
      type,
      season,
      episode,
    });

    const orderedTorrents = await this.streamService.orderTorrents({
      torrents,
      season,
      episode,
      user,
    });

    const { preferredLanguage } = user;

    const userAgent = c.req.header('User-Agent') ?? null;

    let streamType = 'stream';

    if (
      userAgent === null ||
      /Android.*TV/.test(userAgent) ||
      /Google\sTV/.test(userAgent) ||
      /CrKey/.test(userAgent) ||
      /Android/.test(userAgent)
    ) {
      streamType = 'hls';
    }

    const streams = orderedTorrents.map((torrent, i) =>
      this.streamService.convertTorrentToStream({
        torrent,
        isRecommended: i === 0,
        deviceToken,
        season,
        episode,
        preferredLanguage,
        type: streamType,
      }),
    );

    return c.json({ streams });
  }

  public async play(c: Context) {
    const params = c.req.param();
    const result = playSchema.safeParse(params);
    if (!result.success) {
      throw new HTTPException(HttpStatusCode.BAD_REQUEST, {
        message: result.error.message,
      });
    }
    const { sourceName, sourceId, infoHash, fileIdx, type } = result.data;

    let torrent = await this.torrentStoreService.getTorrent(infoHash);

    if (!torrent) {
      const torrentUrl = await this.torrentSource.getTorrentUrlBySourceId({
        sourceId,
        sourceName,
      });
      if (!torrentUrl) {
        throw new HTTPException(HttpStatusCode.NOT_FOUND, {
          message: 'Torrent not found',
        });
      }
      const torrentFilePath = await this.torrentService.downloadTorrentFile(torrentUrl);
      torrent = await this.torrentStoreService.addTorrent(torrentFilePath);
    }

    const file = torrent.files[Number(fileIdx)]!;

    if (type === 'hls') {
      if (c.req.method === 'HEAD') {
        return c.body(null, 200, {
          'Content-Length': `${file.length}`,
          'Content-Type': 'application/vnd.apple.mpegurl',
        });
      }
      const outputDir = path.join(`${env.ADDON_DIR}/hls`, infoHash, `${fileIdx}`);

      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
        const codecInfo = await this.getFileCodecInfoFromStream(file);
        await this.generatePreGeneratedM3U8Audio(outputDir, codecInfo);
        await this.generatePreGeneratedM3U8Subtitle(outputDir, codecInfo);
        await this.generatePreGeneratedM3U8Video(outputDir, codecInfo);
        await this.generatePreGeneratedM3U8Master(outputDir, codecInfo);
        void this.generateHLS(file, outputDir, ``, codecInfo);
      }

      const masterPath = path.join(outputDir, 'master.m3u8');

      while (!existsSync(masterPath)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      while (!existsSync(path.join(outputDir, 'segment_004.ts'))) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const m3u8File = await fs.promises.readFile(masterPath);

      return new Response(m3u8File, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
        },
      });
    } else {
      const fileType = mime.getType(file.path) || 'application/octet-stream';
      if (c.req.method === 'HEAD') {
        return c.body(null, 200, {
          'Content-Length': `${file.length}`,
          'Content-Type': fileType,
        });
      }
      const range = parseRangeHeader(c.req.header('range'), file.length);
      if (!range) {
        console.error(`Invalid range header: ${c.req.header('range')}`);
        return c.body(null, 416, {
          'Content-Range': `bytes */${file.length}`,
        });
      }
      const { start, end } = range;

      console.log(`Range: ${start}-${end}`);

      const stream = file.stream({ start, end });
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${file.length}`,
          'Content-Length': `${end - start + 1}`,
          'Content-Type': fileType,
          'Accept-Ranges': 'bytes',
        },
      });
    }
  }

  private async generateHLS(
    file: WebTorrent.TorrentFile,
    outputDir: string,
    basePath: string,
    codecInfo: {
      videoCodec?: string;
      pixFmt?: string;
      subtitles: { index: number; title: string; language: string }[];
      audioStreams: {
        index: number;
        name: string;
        language: string;
        default: boolean;
        codec: string;
      }[];
    },
  ): Promise<void> {
    const torrentStream = file.createReadStream();

    const hlsArgs = [
      '-i',
      'pipe:0',
      ...(codecInfo.videoCodec === 'h264' && !codecInfo.pixFmt?.includes('10')
        ? ['-c:v', 'copy']
        : ['-c:v', 'libx264', '-preset', 'ultrafast']),
      '-an',
      '-g',
      `250`,
      '-start_number',
      '0',
      '-hls_time',
      `10`,
      '-hls_list_size',
      '0',
      '-hls_segment_filename',
      path.join(outputDir, 'segment_%03d.ts'),
      '-hls_base_url',
      basePath,
      '-f',
      'hls',
      '-hls_playlist_type',
      'vod',
      '-tune',
      'zerolatency',
      path.join(outputDir, 'video.m3u8'),
    ];

    const ffmpegProcess = spawn(ffmpegInstaller.path, hlsArgs, {
      stdio: ['pipe', 'inherit', 'pipe'],
    });

    torrentStream.pipe(ffmpegProcess.stdin!);

    ffmpegProcess.stderr.on('data', (data) => {
      console.log('[FFmpeg stderr]', data.toString());
    });

    torrentStream.on('error', (err) => {
      console.error('[Torrent Stream Error]', err);
      ffmpegProcess.kill('SIGKILL');
    });

    ffmpegProcess.on('exit', async (code) => {
      console.log('[FFmpeg] Process exited with code', code);

      if (code === 0) {
        try {
          console.log('[FFmpeg] Subtitle process exited with code', code);
          if (code === 0) {
            console.log(`Success generating video`);
          }
        } catch (err) {
          console.error('[FFmpeg] Error writing #EXT-X-ENDLIST:', err);
        }
      } else {
        console.error('[FFmpeg] Process failed');
      }
    });

    for (const audio of codecInfo.audioStreams) {
      const audioStream = file.createReadStream();

      const audioArgs = [
        '-i',
        'pipe:0',
        '-map',
        `0:a:${audio.index}`,
        ...(audio.codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac']),
        '-ac',
        '2',
        '-hls_list_size',
        '0',
        '-hls_time',
        `10`,
        '-hls_segment_filename',
        path.join(outputDir, `audio_${audio.index}_%03d.ts`),
        '-f',
        'hls',
        '-hls_playlist_type',
        'vod',
        '-tune',
        'zerolatency',
        path.join(outputDir, `audio_${audio.index}.m3u8`),
      ];

      const audioFfmpegProcess = spawn(ffmpegInstaller.path, audioArgs, {
        stdio: ['pipe', 'inherit', 'pipe'],
      });

      audioStream.pipe(audioFfmpegProcess.stdin!);

      audioFfmpegProcess.stderr.on('data', (data) => {
        console.log(`[FFmpeg Audio ${audio.index} stderr]`, data.toString());
      });

      audioStream.on('error', (err) => {
        console.error(`[Torrent Stream Audio Error ${audio.index}]`, err);
        audioFfmpegProcess.kill('SIGKILL');
      });

      audioFfmpegProcess.on('exit', (code) => {
        console.log(`[FFmpeg Audio ${audio.index}] exited with code`, code);
        if (code === 0) {
          console.log(
            `Success generating audio stream: ${audio.name}, ${audio.language}`,
          );
        }
      });
    }

    for (const subtitle of codecInfo.subtitles) {
      const subtitleStream = file.createReadStream();

      const subtitleArgs = [
        '-i',
        'pipe:0',
        '-map',
        `0:s:${subtitle.index}`,
        '-scodec',
        'webvtt',
        path.join(outputDir, `subtitles_${subtitle.index}.vtt`),
      ];

      const subtitleFfmpegProcess = spawn(ffmpegInstaller.path, subtitleArgs, {
        stdio: ['pipe', 'inherit', 'pipe'],
      });

      subtitleStream.pipe(subtitleFfmpegProcess.stdin!);

      subtitleFfmpegProcess.stderr.on('data', (data) => {
        console.log('FFmpeg Subtitle stderr:', data.toString());
      });

      subtitleStream.on('error', (err) => {
        console.error('[Torrent Stream Error]', err);
        ffmpegProcess.kill('SIGKILL');
      });

      subtitleFfmpegProcess.on('exit', async (code) => {
        console.log('[FFmpeg] Subtitle process exited with code', code);
        if (code === 0) {
          console.log(
            `Success generating subtitle: ${subtitle.title}, ${subtitle.language}`,
          );
          const vttPath = path.join(outputDir, `subtitles_${subtitle.index}.vtt`);
          await this.patchVttWithTimestampMap(vttPath);
        }
      });
    }
  }

  private async generatePreGeneratedM3U8Subtitle(
    outputDir: string,
    codecInfo: {
      duration: number;
      subtitles: {
        index: number;
        title: string;
        language: string;
        forced: boolean;
        default: boolean;
      }[];
    },
  ): Promise<void> {
    for (const subtitle of codecInfo.subtitles) {
      const m3u8Content = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:' + Math.round(codecInfo.duration),
        '#EXT-X-MEDIA-SEQUENCE:0',
      ];

      m3u8Content.push(`#EXTINF:${codecInfo.duration},`);
      m3u8Content.push(`subtitles_${subtitle.index}.vtt`);

      m3u8Content.push('#EXT-X-ENDLIST');

      const m3u8Path = path.join(outputDir, `subtitles_${subtitle.index}.m3u8`);
      await fs.promises.writeFile(m3u8Path, m3u8Content.join('\n'), 'utf-8');
    }
  }

  private async generatePreGeneratedM3U8Audio(
    outputDir: string,
    codecInfo: {
      duration: number;
      audioStreams: {
        index: number;
        name: string;
        language: string;
        default: boolean;
        codec: string;
      }[];
    },
  ): Promise<void> {
    const hlsTime = 10;
    const numberOfSegments = Math.ceil(codecInfo.duration / hlsTime);

    for (const audioStream of codecInfo.audioStreams) {
      const m3u8Content = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:' + hlsTime,
        '#EXT-X-MEDIA-SEQUENCE:0',
      ];

      for (let i = 0; i < numberOfSegments; i++) {
        m3u8Content.push(`#EXTINF:${hlsTime},`);
        m3u8Content.push(
          `audio_${audioStream.index}_${i.toString().padStart(3, '0')}.ts`,
        );
      }

      m3u8Content.push('#EXT-X-ENDLIST');

      const m3u8Path = path.join(outputDir, `audio_${audioStream.index}.m3u8`);
      await fs.promises.writeFile(m3u8Path, m3u8Content.join('\n'), 'utf-8');
    }
  }

  private async generatePreGeneratedM3U8Video(
    outputDir: string,
    codecInfo: { duration: number },
  ): Promise<void> {
    const hlsTime = 10;

    const numberOfSegments = Math.ceil(codecInfo.duration / hlsTime);

    const m3u8Content = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:' + hlsTime,
      '#EXT-X-MEDIA-SEQUENCE:0',
    ];

    for (let i = 0; i < numberOfSegments; i++) {
      m3u8Content.push(`#EXTINF:${hlsTime},`);
      m3u8Content.push(`segment_${i.toString().padStart(3, '0')}.ts`);
    }

    m3u8Content.push('#EXT-X-ENDLIST');

    const m3u8Path = path.join(outputDir, 'video.m3u8');
    await fs.promises.writeFile(m3u8Path, m3u8Content.join('\n'), 'utf-8');
  }

  private async generatePreGeneratedM3U8Master(
    outputDir: string,
    codecInfo: {
      subtitles: {
        index: number;
        title: string;
        language: string;
        forced: boolean;
        default: boolean;
      }[];
      audioStreams: {
        index: number;
        name: string;
        language: string;
        default: boolean;
        codec: string;
      }[];
    },
  ): Promise<void> {
    const m3u8Content = ['#EXTM3U'];

    for (const subtitle of codecInfo.subtitles) {
      m3u8Content.push(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="",NAME="${subtitle.title + subtitle.language + subtitle.forced ? ' (Forced)' : ''}",LANGUAGE="${subtitle.language}",DEFAULT=${subtitle.default ? 'YES' : 'NO'},AUTOSELECT=NO,FORCED=${subtitle.forced ? 'YES' : 'NO'},URI="hls/subtitles_${subtitle.index}.m3u8"`,
      );
    }

    for (const audio of codecInfo.audioStreams) {
      m3u8Content.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="",NAME="${audio.name}",DEFAULT=${audio.default ? 'YES' : 'NO'},AUTOSELECT=YES,LANGUAGE="${audio.language}",URI="hls/audio_${audio.index}.m3u8"`,
      );
    }

    m3u8Content.push(`#EXT-X-STREAM-INF:SUBTITLES="",AUDIO=""`);
    m3u8Content.push('hls/video.m3u8');

    const m3u8Path = path.join(outputDir, 'master.m3u8');
    await fs.promises.writeFile(m3u8Path, m3u8Content.join('\n'), 'utf-8');
  }

  private async patchVttWithTimestampMap(vttPath: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(vttPath, 'utf-8');
      const lines = content.split('\n');

      const headerIndex = lines.findIndex((line) => line.startsWith('WEBVTT'));

      if (headerIndex !== -1) {
        lines.splice(
          headerIndex + 1,
          0,
          'X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:135000',
        );
      }

      await fs.promises.writeFile(vttPath, lines.join('\n'), 'utf-8');
    } catch (err) {
      console.error('[Subtitle Timestamp Patch Error]', err);
    }
  }

  private async getFileCodecInfoFromStream(file: WebTorrent.TorrentFile): Promise<{
    videoCodec?: string;
    pixFmt?: string;
    subtitles: {
      index: number;
      title: string;
      language: string;
      forced: boolean;
      default: boolean;
    }[];
    audioStreams: {
      index: number;
      name: string;
      language: string;
      default: boolean;
      codec: string;
    }[];
    duration: number;
  }> {
    return new Promise((resolve, reject) => {
      ffmpeg(
        new Readable().wrap(file.createReadStream({ start: 0, end: 512 * 1024 })),
      ).ffprobe((err, metadata) => {
        if (err) return reject(err);

        const duration = metadata.format?.duration;

        const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
        const subtitleStreams = metadata.streams
          .filter((s) => s.codec_type === 'subtitle')
          .map((s, index) => ({
            index: index,
            title: s.tags?.title || `${index + 1}`,
            language: s.tags?.language || 'unknown',
            forced: /forced/i.test(s.tags?.title),
            default: index === 0,
          }));
        const audioStreams = metadata.streams
          .filter((s) => s.codec_type === 'audio')
          .map((s, index) => ({
            index,
            name: s.tags?.title || `${index + 1}`,
            language: s.tags?.language || 'unknown',
            default: index === 0,
            codec: s.codec_name || 'unknown',
          }));

        resolve({
          videoCodec: videoStream?.codec_name,
          pixFmt: videoStream?.pix_fmt,
          subtitles: subtitleStreams,
          audioStreams,
          duration: duration ?? 3600,
        });
      });
    });
  }
}
