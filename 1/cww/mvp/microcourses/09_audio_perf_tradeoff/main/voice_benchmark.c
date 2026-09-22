#include "voice_benchmark.h"

#include <inttypes.h>

#include "esp_log.h"

void voice_bench_stats_init(voice_bench_stats_t *stats)
{
    stats->count = 0;
    stats->total_us = 0;
    stats->min_us = UINT32_MAX;
    stats->max_us = 0;
}

void voice_bench_stats_add(voice_bench_stats_t *stats, uint32_t elapsed_us)
{
    stats->count++;
    stats->total_us += elapsed_us;
    if (elapsed_us < stats->min_us) {
        stats->min_us = elapsed_us;
    }
    if (elapsed_us > stats->max_us) {
        stats->max_us = elapsed_us;
    }
}

void voice_bench_stats_log(const char *tag, const char *mode, const char *stage,
                           const voice_bench_stats_t *stats)
{
    if (stats->count == 0) {
        ESP_LOGI(tag, "[BENCH] summary mode=%s stage=%s count=0 avg_us=0 min_us=0 max_us=0",
                 mode, stage);
        return;
    }
    ESP_LOGI(tag, "[BENCH] summary mode=%s stage=%s count=%" PRIu32
             " avg_us=%" PRIu64 " min_us=%" PRIu32 " max_us=%" PRIu32,
             mode, stage, stats->count, stats->total_us / stats->count,
             stats->min_us, stats->max_us);
}
