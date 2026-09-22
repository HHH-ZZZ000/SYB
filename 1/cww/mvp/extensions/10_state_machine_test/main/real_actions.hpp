#pragma once

#include <stdbool.h>

namespace who {
namespace frame_cap {
class WhoFrameCapNode;
}
}

class CatDogClassifier;

typedef void (*real_status_cb_t)(const char *text);

bool real_actions_init(who::frame_cap::WhoFrameCapNode *frame_node,
                       CatDogClassifier *classifier,
                       real_status_cb_t status_cb);
bool real_action_capture(void);
bool real_action_record(void);
bool real_action_infer(void);
bool real_action_save(void);
void real_actions_cleanup_failed(void);
void real_actions_release(void);
