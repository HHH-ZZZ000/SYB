cmake_minimum_required(VERSION 3.5)

set(EXTRA_COMPONENT_DIRS ${CMAKE_CURRENT_LIST_DIR}/components/who_task
                         ${CMAKE_CURRENT_LIST_DIR}/components/who_cam
                         ${CMAKE_CURRENT_LIST_DIR}/components/who_lcd
                         ${CMAKE_CURRENT_LIST_DIR}/components/who_frame_cap
                         ${CMAKE_CURRENT_LIST_DIR}/components/who_frame_lcd_disp)

if (NOT DEFINED BSP)
    set(BSP esp32_s3_eye)
endif()

if (NOT DEFINED SDKCONFIG_DEFAULTS)
    set(SDKCONFIG_DEFAULTS sdkconfig.defaults)
endif()

add_compile_options(-fdiagnostics-color=always)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(camera_catdog_live)