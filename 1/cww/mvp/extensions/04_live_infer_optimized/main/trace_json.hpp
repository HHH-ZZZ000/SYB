#pragma once

#include <stdint.h>

// The normal optimized build keeps the trace path out of the runtime. Enable
// it with: idf.py -DPERFETTO_TRACE_JSON=1 build
#ifndef PERFETTO_TRACE_JSON
#define PERFETTO_TRACE_JSON 0
#endif

namespace perfetto_trace {

void init();

// Records one complete Chrome Trace event. Timestamps are absolute
// esp_timer_get_time() values; the implementation stores them relative to
// the trace start time.
void record_complete(const char *name,
                     const char *category,
                     int64_t start_us,
                     int64_t end_us,
                     int32_t pid,
                     int32_t tid,
                     int core);

// Prints one complete JSON document between TRACE_JSON_BEGIN/END markers.
void dump();

}  // namespace perfetto_trace
