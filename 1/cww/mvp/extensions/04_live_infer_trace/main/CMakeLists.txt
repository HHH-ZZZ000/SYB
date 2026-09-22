set(BASELINE_DIR ${CMAKE_CURRENT_LIST_DIR}/../../../extensions/03_live_catdog_assignment)
set(model_file "${BASELINE_DIR}/main/models/s3/catdog_mobilenet_v2.espdl")
set(embedded_model "${CMAKE_CURRENT_BINARY_DIR}/catdog_mobilenet_v2.espdl")
if(NOT EXISTS "${model_file}")
    message(FATAL_ERROR "Missing model file: ${model_file}")
endif()
configure_file("${model_file}" "${embedded_model}" COPYONLY)

idf_component_register(
    SRCS "app_main.cpp" "frame_cap_pipeline.cpp" "trace_json.cpp"
    INCLUDE_DIRS "."
    EMBED_FILES "${embedded_model}"
    REQUIRES who_frame_lcd_disp esp_event nvs_flash)

set(PERFETTO_TRACE_JSON OFF CACHE BOOL "Print a Chrome Trace JSON document after a short benchmark run")
if(PERFETTO_TRACE_JSON)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE PERFETTO_TRACE_JSON=1)
    message(STATUS "PERFETTO_TRACE_JSON is enabled")
endif()

set(default_bsp esp32_s3_eye)
if (DEFINED BSP)
    set(default_bsp ${BSP})
endif()
set(bsp_components ${default_bsp} espressif__${default_bsp})
idf_component_optional_requires(PUBLIC ${bsp_components})
