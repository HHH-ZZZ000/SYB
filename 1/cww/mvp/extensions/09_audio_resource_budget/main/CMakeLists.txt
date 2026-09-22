set(BENCH_DIR ${CMAKE_CURRENT_LIST_DIR}/../../../microcourses/09_audio_perf_tradeoff/main)
idf_component_register(
    SRCS "${BENCH_DIR}/main.c" "${BENCH_DIR}/voice_benchmark.c"
    INCLUDE_DIRS "${BENCH_DIR}"
    REQUIRES voice_common esp-sr esp_timer esp_hw_support heap)

if (DEFINED BENCH_MODE)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE VOICE_BENCH_MODE=${BENCH_MODE})
endif()
