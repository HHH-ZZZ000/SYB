#pragma once

#include <stdint.h>

// 普通构建不启用追踪。使用 idf.py -DPERFETTO_TRACE_JSON=1 build 开启。
#ifndef PERFETTO_TRACE_JSON
#define PERFETTO_TRACE_JSON 0
#endif

namespace perfetto_trace {

void init();

// 记录一个 Chrome Trace 完整事件。传入的时间戳来自 esp_timer_get_time()；
// 实现会将其转换为相对于 trace 开始时刻的微秒数。
void record_complete(const char *name,
                     const char *category,
                     int64_t start_us,
                     int64_t end_us,
                     int32_t pid,
                     int32_t tid,
                     int core);

// 在 TRACE_JSON_BEGIN/END 标记之间打印一个完整 JSON 文档。
void dump();

}  // namespace perfetto_trace
