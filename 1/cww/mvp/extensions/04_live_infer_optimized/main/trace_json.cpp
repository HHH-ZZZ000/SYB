#include "trace_json.hpp"

#if PERFETTO_TRACE_JSON

#include "esp_timer.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

#include <algorithm>
#include <inttypes.h>
#include <iterator>
#include <stdio.h>

namespace {

constexpr size_t kMaxEvents = 256;

struct TraceEvent {
    const char *name;
    const char *category;
    int64_t timestamp_us;
    int64_t duration_us;
    int32_t pid;
    int32_t tid;
    int core;
};

TraceEvent s_events[kMaxEvents];
size_t s_event_count = 0;
int64_t s_trace_start_us = 0;
bool s_initialized = false;
bool s_dumping = false;
portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;

void print_json_string(const char *value)
{
    putchar('"');
    for (const char *cursor = value; cursor && *cursor; ++cursor) {
        switch (*cursor) {
        case '"':
            fputs("\\\"", stdout);
            break;
        case '\\':
            fputs("\\\\", stdout);
            break;
        case '\n':
            fputs("\\n", stdout);
            break;
        case '\r':
            fputs("\\r", stdout);
            break;
        case '\t':
            fputs("\\t", stdout);
            break;
        default:
            putchar(*cursor);
            break;
        }
    }
    putchar('"');
}

}  // namespace

namespace perfetto_trace {

void init()
{
    portENTER_CRITICAL(&s_lock);
    s_event_count = 0;
    s_trace_start_us = esp_timer_get_time();
    s_initialized = true;
    s_dumping = false;
    portEXIT_CRITICAL(&s_lock);
}

void record_complete(const char *name,
                     const char *category,
                     int64_t start_us,
                     int64_t end_us,
                     int32_t pid,
                     int32_t tid,
                     int core)
{
    if (!name || !category || end_us < start_us) {
        return;
    }

    portENTER_CRITICAL(&s_lock);
    if (s_initialized && !s_dumping && s_event_count < kMaxEvents) {
        TraceEvent &event = s_events[s_event_count++];
        event.name = name;
        event.category = category;
        event.timestamp_us = std::max<int64_t>(0, start_us - s_trace_start_us);
        event.duration_us = end_us - start_us;
        event.pid = pid;
        event.tid = tid;
        event.core = core;
    }
    portEXIT_CRITICAL(&s_lock);
}

void dump()
{
    portENTER_CRITICAL(&s_lock);
    s_dumping = true;
    portEXIT_CRITICAL(&s_lock);

    // Keep application and component log lines from interleaving with the
    // JSON document while it is being copied from the serial monitor.
    esp_log_level_set("*", ESP_LOG_NONE);

    // Events can be produced by the preview and inference tasks in either
    // order. Sort them before printing so Perfetto receives a chronological
    // trace even when the two tasks race to append an event.
    std::sort(std::begin(s_events), std::begin(s_events) + s_event_count,
              [](const TraceEvent &left, const TraceEvent &right) {
                  return left.timestamp_us < right.timestamp_us;
              });

    fputs("TRACE_JSON_BEGIN\n", stdout);
    fputs("{\"traceEvents\":[\n", stdout);
    for (size_t index = 0; index < s_event_count; ++index) {
        const TraceEvent &event = s_events[index];
        if (index != 0) {
            fputs(",\n", stdout);
        }
        fputs("{\"name\":", stdout);
        print_json_string(event.name);
        fputs(",\"cat\":", stdout);
        print_json_string(event.category);
        printf(",\"ph\":\"X\",\"ts\":%" PRId64
               ",\"dur\":%" PRId64 ",\"pid\":%" PRId32
               ",\"tid\":%" PRId32 ",\"args\":{\"core\":%d}}",
               event.timestamp_us, event.duration_us, event.pid, event.tid, event.core);
    }
    fputs("\n],\"displayTimeUnit\":\"us\"}\n", stdout);
    fputs("TRACE_JSON_END\n", stdout);
    fflush(stdout);
}

}  // namespace perfetto_trace

#else

namespace perfetto_trace {

void init() {}

void record_complete(const char *, const char *, int64_t, int64_t, int32_t, int32_t, int) {}

void dump() {}

}  // namespace perfetto_trace

#endif
