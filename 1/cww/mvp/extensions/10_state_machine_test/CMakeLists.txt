cmake_minimum_required(VERSION 3.5)

set(BASELINE_DIR ${CMAKE_CURRENT_LIST_DIR}/../03_live_catdog_assignment)
set(EXTRA_COMPONENT_DIRS
    ${BASELINE_DIR}/components/who_task
    ${BASELINE_DIR}/components/who_cam
    ${BASELINE_DIR}/components/who_lcd
    ${BASELINE_DIR}/components/who_frame_cap
    ${BASELINE_DIR}/components/who_frame_lcd_disp
    ${CMAKE_CURRENT_LIST_DIR}/../../components/voice_common)

add_compile_options(-Wno-error=incompatible-pointer-types)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(state_machine_test)
