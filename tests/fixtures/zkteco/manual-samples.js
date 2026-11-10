/**
 * ZKTeco Security PUSH request samples, from the protocol manual (3.1.2, doc 4.8, Jan 2024)
 * and the formats GymBioSync parses. No real person: PINs, names and templates are made up.
 * The manual prints tabs as spaces; the device sends tabs. Both are kept where they differ.
 *
 * Phase 0 device captures (docs/runbooks/zkteco-phase0-checklist.md) are added here, sanitized,
 * when they arrive.
 */
const TEMPLATE = `TAlTUzIxAAAFSksECAUHCc7QAAAdS2kBAAAAhfcvU0o3AIAP${'A'.repeat(1700)}`;
const PHOTO = `/9j/4AAQSkZJRgABAQAAAQABAAD${'B'.repeat(3000)}`;

module.exports = {
  TEMPLATE,
  PHOTO,

  // POST /iclock/registry (§4.3): comma separated, some keys with a leading ~
  registry:
    'DeviceType=acc,~DeviceName=SpeedFace-V5L [TD],FirmVer=ZAM180-NF-Ver1.0.1,PushVersion=3.1.2,' +
    'MAC=00:17:61:12:34:56,CommType=ethernet,MaxPackageSize=2048000,LockCount=1,ReaderCount=2,' +
    'AuxInCount=1,AuxOutCount=1,MachineType=101,~IsOnlyRFMachine=0,~MaxUserCount=10000,' +
    '~MaxAttLogCount=100000,~MaxUserFingerCount=10,MultiBioDataSupport=0:1:1:0:0:0:0:0:0:1:0,' +
    'MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1:0,MultiBioVersion=0:10.0:0:0:0:0:0:0:0:40.1:0,' +
    'MaxMultiBioDataCount=0:5000:0:0:0:0:0:0:0:5000:0,DateFmtFunOn=1,authKey=123456',

  // POST /iclock/cdata?table=options
  options: '~DeviceName=SpeedFace-V5L,UserCount=12,FPCount=3,FaceCount=11,TransactionCount=420,FirmVer=ZAM180',

  // POST /iclock/cdata?table=rtlog (tab-separated; the time holds a space)
  rtlogTab:
    'time=2026-11-10 10:00:00\tpin=9001\tcardno=0\teventaddr=1\tevent=0\tinoutstatus=0\tverifytype=15\tindex=21\n' +
    'time=2026-11-10 10:00:05\tpin=0\tcardno=0\teventaddr=1\tevent=206\tinoutstatus=2\tverifytype=200\tindex=22\n',
  // The manual's own rtlog example, tabs printed as spaces
  rtlogSpaces: 'time=2017-01-10 11:49:32 pin=0 cardno=0 eventaddr=1 event=206 inoutstatus=2 verifytype=200 index=1',

  // ATTLOG positional fallback (attendance firmware): pin, time, status, verify, workcode
  attlog: '9001\t2026-11-10 10:00:00\t0\t15\t0\t0\t0\n9002\t2026-11-10 10:01:00\t1\t1\t0\t0\t0',

  // tabledata uploads
  userTab: 'user uid=1\tcardno=\tpin=9001\tpassword=\tgroup=1\tstarttime=0\tendtime=0\tname=Test Person\tprivilege=0\tdisable=0\tverify=0',
  biodataSpaces: `biodata pin=9001 no=0 index=0 valid=1 duress=0 type=9 majorver=40 minorver=1 format=0 tmp=${TEMPLATE}`,
  biodataGlued: `biodatapin=9001\tno=6\tindex=0\tvalid=1\tduress=0\ttype=1\tmajorver=10\tminorver=0\tformat=0\ttmp=${TEMPLATE}`,
  templatev10: `templatev10 size=1808\tuid=4\tpin=9001\tfingerid=7\tvalid=1\ttemplate=${TEMPLATE}`,
  biophoto: `biophoto pin=9001\tfilename=9001.jpg\ttype=9\tsize=${PHOTO.length}\tcontent=${PHOTO}`,
  userpic: `userpic pin=9001\tfilename=9001.jpg\tsize=${PHOTO.length}\tcontent=${PHOTO}`,
  attphoto: `pin=20261110100000-9001.jpg\tsn=CQZ7224460123\tsize=${PHOTO.length}\tcmd=uploadphoto\tphoto=${PHOTO}`,

  // POST /iclock/devicecmd: several results, Return and return both occur
  devicecmd: 'ID=1001&Return=0&CMD=DATA UPDATE\nID=1002&return=-30&CMD=DATA\r\nID=1003&Return=-708&CMD=ENROLL_BIO\n',

  // ENROLL_BIO result (POST /iclock/cdata?type=BioData)
  enrollResult: `TYPE=9\tPIN=9001\tNO=0\tINDEX=0\tMAJOR_VER=58\tMINOR_VER=1\tTMP=${TEMPLATE}\r\nBIOPHOTO=${PHOTO}`,

  // querydata packs
  queryUsersPack1: 'user uid=1\tcardno=\tpin=9001\tname=Test Person\tprivilege=0\nuser uid=2\tcardno=\tpin=9002\tname=Second\tprivilege=0',
  queryCount: 'user=6',
};
