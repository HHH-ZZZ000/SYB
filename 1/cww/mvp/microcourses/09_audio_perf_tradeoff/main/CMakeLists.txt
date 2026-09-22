idf_component_register(
    SRCS main.c voice_benchmark.c
    REQUIRES voice_common esp-sr esp_timer esp_hw_support heap)
