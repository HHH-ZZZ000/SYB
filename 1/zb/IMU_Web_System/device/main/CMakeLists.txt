if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/config.local.h")
    message(FATAL_ERROR "Run python configure.py --server http://COMPUTER_LAN_IP:5000 to create the local Wi-Fi configuration.")
endif()
idf_component_register(
    SRCS "main.c" "qma6100p.c" "camera_monitor.c" "button_capture.c" "led_feedback.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES esp_driver_i2c esp_driver_gpio esp_adc esp_timer esp_wifi esp_event esp_netif nvs_flash esp_http_client esp_http_server esp_psram esp32-camera lwip json
)
