#ifndef MultitouchBridge_h
#define MultitouchBridge_h

#include <CoreFoundation/CoreFoundation.h>

typedef struct { float x; float y; } MTPoint;
typedef struct { MTPoint pos; MTPoint vel; } MTReadout;

typedef struct {
    int frame;
    double timestamp;
    int identifier;
    int state;
    int fingerID;
    int handID;
    MTReadout normalized;
    float size;
    int zero1;
    float angle;
    float majorAxis;
    float minorAxis;
    MTReadout absolute;
    int zero2[2];
    float density;
} MTTouch;

typedef void *MTDeviceRef;
typedef int (*MTContactCallbackFunction)(int device, MTTouch *touches, int nFingers, double timestamp, int frame);

#endif
