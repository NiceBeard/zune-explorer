const ContainerType = {
  COMMAND:  0x0001,
  DATA:     0x0002,
  RESPONSE: 0x0003,
  EVENT:    0x0004,
};

const OperationCode = {
  GetDeviceInfo:    0x1001,
  OpenSession:      0x1002,
  CloseSession:     0x1003,
  GetStorageIDs:    0x1004,
  GetStorageInfo:   0x1005,
  GetNumObjects:    0x1006,
  GetObjectHandles: 0x1007,
  GetObjectInfo:    0x1008,
  SendObjectInfo:   0x100C,
  SendObject:       0x100D,
  SetDevicePropValue: 0x1016,
  // WMDRMPD vendor extensions (used by MTPZ)
  SendWMDRMPDAppRequest:        0x9212,
  GetWMDRMPDAppResponse:        0x9213,
  EnableTrustedFilesOperations: 0x9214,
  EndTrustedAppSession:         0x9216,
};

const ResponseCode = {
  OK:                    0x2001,
  GeneralError:          0x2002,
  SessionNotOpen:        0x2003,
  InvalidTransactionID:  0x2004,
  OperationNotSupported: 0x2005,
  ParameterNotSupported: 0x2006,
  InvalidStorageID:      0x2008,
  InvalidObjectHandle:   0x2009,
  StoreFull:             0x200C,
  ObjectWriteProtected:  0x200D,
};

const ObjectFormat = {
  Undefined:   0x3000,
  Association: 0x3001, // folder
  MP3:         0x3009,
  JPEG:        0x3801,
  WMA:         0xB901,
  AAC:         0xB903,
  WMV:         0xB981,
  MP4:         0xB982,
};

const ExtensionToFormat = {
  '.mp3':  ObjectFormat.MP3,
  '.wma':  ObjectFormat.WMA,
  '.aac':  ObjectFormat.AAC,
  '.m4a':  ObjectFormat.AAC,
  '.wmv':  ObjectFormat.WMV,
  '.mp4':  ObjectFormat.MP4,
  '.m4v':  ObjectFormat.MP4,
  '.jpg':  ObjectFormat.JPEG,
  '.jpeg': ObjectFormat.JPEG,
};

const DeviceProperty = {
  SessionInitiatorInfo: 0xD406,
};

const CONTAINER_HEADER_SIZE = 12;

module.exports = {
  ContainerType,
  OperationCode,
  ResponseCode,
  ObjectFormat,
  ExtensionToFormat,
  DeviceProperty,
  CONTAINER_HEADER_SIZE,
};
