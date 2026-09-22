cmake_minimum_required(VERSION 3.5)

if (NOT DEFINED BSP)
    set(BSP esp32_s3_eye)
endif()

if (NOT DEFINED SDKCONFIG_DEFAULTS)
    set(SDKCONFIG_DEFAULTS sdkconfig.defaults)
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(catdog_static_infer)
