set(include_dirs    .
                    who_s3_cam)
set(src_dirs who_s3_cam)

set(requires esp_timer esp-dl esp_lcd espressif__esp32-camera)

set(bsp_components esp32_s3_eye espressif__esp32_s3_eye)

idf_component_register(SRC_DIRS ${src_dirs} INCLUDE_DIRS ${include_dirs} REQUIRES ${requires})
idf_component_optional_requires(PUBLIC ${bsp_components})
