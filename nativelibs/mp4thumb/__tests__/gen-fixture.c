// Test-fixture generator: synthesizes a deterministic image and MJPEG-encodes it
// to argv[1] (a raw JPEG). The addon reads it back as a 1-frame video via FFmpeg's
// image2 demuxer, exercising the full decode->scale->encode->mux pipeline. Compiled
// at test time against the pinned FFmpeg (no system ffmpeg needed).
//   usage: gen-fixture <out.jpg> <width> <height>
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char** argv) {
  if (argc < 4) { fprintf(stderr, "usage: gen-fixture <out> <w> <h>\n"); return 2; }
  int W = atoi(argv[2]), H = atoi(argv[3]);

  const AVCodec* enc = avcodec_find_encoder(AV_CODEC_ID_MJPEG);
  if (!enc) { fprintf(stderr, "no mjpeg encoder\n"); return 1; }
  AVCodecContext* c = avcodec_alloc_context3(enc);
  c->width = W; c->height = H; c->pix_fmt = AV_PIX_FMT_YUVJ420P;
  c->time_base = (AVRational){1, 1};
  if (avcodec_open2(c, enc, NULL) < 0) { fprintf(stderr, "open2 failed\n"); return 1; }

  AVFrame* f = av_frame_alloc();
  f->format = AV_PIX_FMT_YUVJ420P; f->width = W; f->height = H;
  av_frame_get_buffer(f, 0);
  for (int y = 0; y < H; y++)
    for (int x = 0; x < W; x++)
      f->data[0][y * f->linesize[0] + x] = (unsigned char)((x ^ y) & 0xff);
  for (int y = 0; y < H / 2; y++)
    for (int x = 0; x < W / 2; x++) {
      f->data[1][y * f->linesize[1] + x] = (unsigned char)(x & 0xff);
      f->data[2][y * f->linesize[2] + x] = (unsigned char)(y & 0xff);
    }
  f->pts = 0;

  AVPacket* p = av_packet_alloc();
  if (avcodec_send_frame(c, f) < 0 || avcodec_receive_packet(c, p) < 0) {
    fprintf(stderr, "encode failed\n"); return 1;
  }
  FILE* fp = fopen(argv[1], "wb");
  if (!fp) { fprintf(stderr, "cannot open %s\n", argv[1]); return 1; }
  fwrite(p->data, 1, p->size, fp);
  fclose(fp);

  av_packet_free(&p);
  av_frame_free(&f);
  avcodec_free_context(&c);
  return 0;
}
