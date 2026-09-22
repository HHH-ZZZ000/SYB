cmake_minimum_required(VERSION 3.5)

set(BASELINE_DIR ${CMAKE_CURRENT_LIST_DIR}/../03_live_catdog_assignment)
set(EXTRA_COMPONENT_DIRS
    ${BASELINE_DIR}/components/who_task
    ${BASELINE_DIR}/components/who_cam
    ${BASELINE_DIR}/components/who_lcd
    ${BASELINE_DIR}/components/who_frame_cap
    ${BASELINE_DIR}/components/who_frame_lcd_disp)

if (NOT DEFINED BSP)
    set(BSP esp32_s3_eye)
endif()
if (NOT DEFINED SDKCONFIG_DEFAULTS)
    set(SDKCONFIG_DEFAULTS sdkconfig.defaults)
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(camera_catdog_perfetto_trace)
