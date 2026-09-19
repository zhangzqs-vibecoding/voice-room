import { useEffect, useRef } from 'react';

export interface VideoParticipant {
  id: string;
  name: string;
  avatar: string;
  track?: MediaStreamTrack;
  cameraEnabled: boolean;
  speaking: boolean;
  host?: boolean;
  trackSid?: string;
  microphoneTrackSid?: string;
}

const VideoTile = ({ participant, featured }: { participant: VideoParticipant; featured?: boolean }) => {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!video.current) return;
    video.current.srcObject = participant.track ? new MediaStream([participant.track]) : null;
    return () => { if (video.current) video.current.srcObject = null; };
  }, [participant.track]);
  return <article className={`video-tile${featured ? ' video-tile-featured' : ''}`} data-participant={participant.id} data-track-sid={participant.trackSid ?? ''} data-mic-track-sid={participant.microphoneTrackSid ?? ''} data-speaking={participant.speaking}>
    {participant.track && participant.cameraEnabled ? <video ref={video} autoPlay playsInline muted={participant.id === 'self'} /> : <div className="video-avatar" aria-label={`${participant.name} 摄像头已关闭`}>{participant.avatar}</div>}
    <div className="video-name"><span>{participant.speaking ? '● ' : ''}{participant.name}</span>{participant.host && <small>主持人</small>}</div>
  </article>;
};

export const MeetingLayout = ({ participants, activeSpeakerIds = [], screenTrack }: { participants: VideoParticipant[]; activeSpeakerIds?: string[]; screenTrack?: MediaStreamTrack }) => {
  const featuredId = activeSpeakerIds[0] ?? participants[0]?.id;
  const featured = participants.find((participant) => participant.id === featuredId) ?? participants[0];
  const thumbnails = participants.filter((participant) => participant.id !== featured?.id);
  const screen = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!screen.current) return;
    screen.current.srcObject = screenTrack ? new MediaStream([screenTrack]) : null;
    return () => { if (screen.current) screen.current.srcObject = null; };
  }, [screenTrack]);
  return <section className="meeting-layout" aria-label="视频会议画面">
    {screenTrack && <div className="screen-share"><video ref={screen} autoPlay playsInline /><span>正在共享屏幕</span></div>}
    {featured && <VideoTile participant={featured} featured />}
    <div className="video-thumbnails">{thumbnails.map((participant) => <VideoTile participant={participant} key={participant.id} />)}</div>
  </section>;
};
