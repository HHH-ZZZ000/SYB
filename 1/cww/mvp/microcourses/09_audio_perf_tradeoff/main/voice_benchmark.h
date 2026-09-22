#pragma once

#include <stdint.h>

typedef struct {
    uint32_t count;
    uint64_t total_us;
    uint32_t min_us;
    uint32_t max_us;
} voice_bench_stats_t;

void voice_bench_stats_init(voice_bench_stats_t *stats);
void voice_bench_stats_add(voice_bench_stats_t *stats, uint32_t elapsed_us);
void voice_bench_stats_log(const char *tag, const char *mode, const char *stage,
                           const voice_bench_stats_t *stats);
