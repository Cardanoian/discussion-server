import { supabase } from '../supabaseClient';
import { avatarStyles, type AvatarStyle } from '../types/avatar';
import { genAI } from './gemini';
import sharp from 'sharp';

interface GenerateAvatarOptions {
  style: AvatarStyle;
  customization: string;
}

/**
 * Google Gemini Imagen API를 사용하여 아바타 생성
 */
async function generateAvatarWithGemini({
  style,
  customization,
}: GenerateAvatarOptions): Promise<Blob> {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Google API key is not configured');
    }

    // 선택한 스타일 찾기
    const selectedStyle = avatarStyles.find((s) => s.id === style);
    if (!selectedStyle) {
      throw new Error(`Invalid avatar style: ${style}`);
    }

    // 프롬프트 구성
    const prompt = `${selectedStyle.prompt.replace(
      '{character}',
      customization
    )}, square aspect ratio, centered composition, professional avatar for social media profile, no text, no watermark`;

    console.log('Generating avatar with prompt:', prompt);

    const response = await genAI.models.generateContent({
      model: 'gemini-2.5-flash-image-preview',
      contents: prompt,
      config: { responseModalities: ['IMAGE'] },
    });

    if (!response.candidates || response.candidates.length === 0) {
      throw new Error('응답에 후보가 없습니다. API 키 권한을 확인해주세요.');
    }

    const candidate = response.candidates[0];

    if (!candidate.content || !candidate.content.parts) {
      throw new Error('응답 구조가 올바르지 않습니다.');
    }

    // parts 배열에서 이미지 데이터 찾기
    let imageData: string | undefined;
    let responseText = '';

    for (const part of candidate.content.parts) {
      if (part.text) {
        responseText += part.text;
      } else if (part.inlineData) {
        imageData = part.inlineData.data;
        break;
      } else {
        console.error(`⚠️ 알 수 없는 part 타입: ${Object.keys(part)}`);
      }
    }

    if (!imageData) {
      throw new Error(
        `이미지 데이터가 없습니다. 텍스트 응답만 받았습니다.\n\n받은 응답: "${responseText}"\n\n가능한 원인:\n1. API 키에 이미지 생성 권한이 없을 수 있습니다.\n2. 지역 제한으로 이미지 생성 기능을 사용할 수 없을 수 있습니다.\n3. 프롬프트를 더 명확하게 작성해보세요.`
      );
    }

    // Base64를 Blob으로 변환
    const binaryString = atob(imageData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return new Blob([bytes], { type: 'image/png' });
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`이미지 생성 요청 실패: ${error.message}`);
    } else {
      throw new Error('이미지 생성 요청 실패: 알 수 없는 오류');
    }
  }
}

/**
 * 이미지 리사이즈 및 최적화
 */
async function resizeAndOptimizeImage(blob: Blob): Promise<Buffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // 256x256 크기로 리사이즈하고 품질 최적화
  const resizedBuffer = await sharp(buffer)
    .resize(256, 256, {
      fit: 'cover',
      position: 'center',
    })
    .png({
      quality: 80,
      compressionLevel: 9,
    })
    .toBuffer();

  return resizedBuffer;
}

/**
 * Supabase Storage에 아바타 업로드
 */
async function uploadAvatarToStorage(
  userId: string,
  blob: Blob
): Promise<string> {
  const timestamp = Date.now();
  const fileName = `${userId}_${timestamp}.png`;

  // 이미지 리사이즈 및 최적화
  const optimizedBuffer = await resizeAndOptimizeImage(blob);

  // Storage 버킷 확인 및 생성
  const { data: buckets } = await supabase.storage.listBuckets();
  const avatarsBucket = buckets?.find((b) => b.name === 'avatar_img');

  if (!avatarsBucket) {
    console.log('Creating avatar_img bucket...');
    const { error: createError } = await supabase.storage.createBucket(
      'avatar_img',
      {
        public: true,
        allowedMimeTypes: ['image/png', 'image/jpeg', 'image/svg+xml'],
      }
    );

    if (createError) {
      console.error('Error creating bucket:', createError);
      throw createError;
    }
  }

  // 해당 사용자의 모든 이전 아바타 파일 삭제
  const { data: existingFiles } = await supabase.storage
    .from('avatar_img')
    .list('', {
      search: userId,
    });

  if (existingFiles && existingFiles.length > 0) {
    const filesToDelete = existingFiles
      .filter((file) => file.name.startsWith(`${userId}_`))
      .map((file) => file.name);

    if (filesToDelete.length > 0) {
      const { error: deleteError } = await supabase.storage
        .from('avatar_img')
        .remove(filesToDelete);

      if (deleteError) {
        console.log('Error deleting old files:', deleteError);
      } else {
        console.log(`Deleted ${filesToDelete.length} old avatar file(s)`);
      }
    }
  }

  // 새 아바타 업로드 (최적화된 버퍼 사용)
  const { error: uploadError } = await supabase.storage
    .from('avatar_img')
    .upload(fileName, optimizedBuffer, {
      contentType: 'image/png',
      cacheControl: '3600',
      upsert: false,
    });

  if (uploadError) {
    console.error('Error uploading avatar:', uploadError);
    throw uploadError;
  }

  console.log(
    `Avatar uploaded successfully. Original size: ${blob.size} bytes, Optimized size: ${optimizedBuffer.length} bytes`
  );

  // Public URL 가져오기
  const { data: urlData } = supabase.storage
    .from('avatar_img')
    .getPublicUrl(fileName);

  return urlData.publicUrl;
}

/**
 * 아바타 생성 및 프로필 업데이트
 */
export async function createAndUpdateAvatar(
  userId: string,
  style: AvatarStyle,
  customization: string
): Promise<string> {
  // 1. Gemini로 이미지 생성
  const blob = await generateAvatarWithGemini({
    style,
    customization,
  });

  // 2. Storage에 업로드
  const avatarUrl = await uploadAvatarToStorage(userId, blob);

  // 3. DB(user_profile) 업데이트
  const { error } = await supabase
    .from('user_profile')
    .update({ avatar_url: avatarUrl })
    .eq('user_uuid', userId);

  if (error) {
    console.error('Error updating profile:', error);
    throw new Error('프로필 업데이트에 실패했습니다.');
  }

  return avatarUrl;
}
