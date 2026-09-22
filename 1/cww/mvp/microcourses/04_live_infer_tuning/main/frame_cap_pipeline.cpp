#include "frame_cap_pipeline.hpp"
#include "who_cam.hpp"
using namespace who::cam;
using namespace who::frame_cap;
WhoFrameCap *get_preview_frame_cap_pipeline()
{
    framesize_t frame_size = get_cam_frame_size_from_lcd_resolution();
    auto cam = new WhoS3Cam(PIXFORMAT_RGB565, frame_size, 3);
    auto frame_cap = new WhoFrameCap();
    frame_cap->add_node<WhoFetchNode>("FrameCapFetch", cam);
    return frame_cap;
}
