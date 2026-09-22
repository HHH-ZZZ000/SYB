set(BASELINE_DIR ${CMAKE_CURRENT_LIST_DIR}/../../03_live_catdog_assignment)
set(STATE_DIR ${CMAKE_CURRENT_LIST_DIR}/../../../microcourses/10_system_state_machine/main)
set(MODEL_FILE "${BASELINE_DIR}/main/models/s3/catdog_mobilenet_v2.espdl")
set(EMBEDDED_MODEL "${CMAKE_CURRENT_BINARY_DIR}/catdog_mobilenet_v2.espdl")

if(NOT EXISTS "${MODEL_FILE}")
    message(FATAL_ERROR "Missing model file: ${MODEL_FILE}")
endif()
configure_file("${MODEL_FILE}" "${EMBEDDED_MODEL}" COPYONLY)

idf_component_register(
    SRCS
        "main.cpp"
        "real_actions.cpp"
        "${STATE_DIR}/state_machine.c"
        "${BASELINE_DIR}/main/frame_cap_pipeline.cpp"
    INCLUDE_DIRS
        "."
        "${STATE_DIR}"
        "${BASELINE_DIR}/main"
    EMBED_FILES "${EMBEDDED_MODEL}"
    REQUIRES who_frame_lcd_disp esp_event nvs_flash voice_common)

set(default_bsp esp32_s3_eye)
if (DEFINED BSP)
    set(default_bsp ${BSP})
endif()
set(bsp_components ${default_bsp} espressif__${default_bsp})
idf_component_optional_requires(PUBLIC ${bsp_components})

if (DEFINED REAL_ACTION_SCENARIO)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE REAL_ACTION_SCENARIO=${REAL_ACTION_SCENARIO})
endif()
